'use strict'
import { Neovim } from '@chemzqm/neovim'
import fs from 'fs'
import path from 'path'
import util from 'util'
import { Disposable, DocumentSelector } from 'vscode-languageserver-protocol'
import events from '../events'
import extensions from '../extension'
import BufferSync from '../model/bufferSync'
import { CompletionItemProvider } from '../provider'
import { CompleteOption, ExtendedCompleteItem, ISource, SourceConfig, SourceStat, SourceType } from '../types'
import { disposeAll, getUri } from '../util'
import { intersect } from '../util/array'
import { statAsync } from '../util/fs'
import { byteSlice } from '../util/string'
import window from '../window'
import workspace from '../workspace'
import KeywordsBuffer from './keywords'
import Source from './source'
import LanguageSource from './source-language'
import VimSource from './source-vim'
const logger = require('../util/logger')('sources')

export class Sources {
  private sourceMap: Map<string, ISource> = new Map()
  private disposables: Disposable[] = []
  private remoteSourcePaths: string[] = []
  private keywords: BufferSync<KeywordsBuffer>

  public init(): void {
    this.keywords = workspace.registerBufferSync(doc => {
      return new KeywordsBuffer(doc)
    })
    this.createNativeSources()
    this.createRemoteSources()
    events.on('InsertLeave', () => {
      for (let item of this.keywords.items) {
        item.parse()
      }
    }, this, this.disposables)
    events.on('BufEnter', this.onDocumentEnter, this, this.disposables)
    workspace.onDidRuntimePathChange(newPaths => {
      for (let p of newPaths) {
        if (p) void this.createVimSources(p)
      }
    }, null, this.disposables)
  }

  public getShortcut(name: string): string {
    let source = this.sourceMap.get(name)
    return source ? source.shortcut : ''
  }

  private get nvim(): Neovim {
    return workspace.nvim
  }

  private createNativeSources(): void {
    this.disposables.push((require('./native/around')).register(this.sourceMap, this.keywords))
    this.disposables.push((require('./native/buffer')).register(this.sourceMap, this.keywords))
    this.disposables.push((require('./native/file')).register(this.sourceMap))
  }

  public createLanguageSource(
    name: string,
    shortcut: string,
    selector: DocumentSelector | null,
    provider: CompletionItemProvider,
    triggerCharacters: string[],
    priority?: number | undefined,
    allCommitCharacters?: string[]
  ): Disposable {
    let source = new LanguageSource(
      name,
      shortcut,
      provider,
      selector,
      triggerCharacters || [],
      allCommitCharacters || [],
      priority)
    logger.debug('created service source', name)
    this.sourceMap.set(name, source)
    return {
      dispose: () => {
        this.sourceMap.delete(name)
      }
    }
  }

  private async createVimSourceExtension(nvim: Neovim, filepath: string): Promise<void> {
    let name = path.basename(filepath, '.vim')
    try {
      await nvim.command(`source ${filepath}`)
      let fns = await nvim.call('coc#util#remote_fns', name) as string[]
      for (let fn of ['init', 'complete']) {
        if (!fns.includes(fn)) {
          void window.showErrorMessage(`${fn} not found for source ${name}`)
          return null
        }
      }
      let props = await nvim.call(`coc#source#${name}#init`, [])
      let packageJSON = {
        name: `coc-source-${name}`,
        engines: {
          coc: ">= 0.0.1"
        },
        activationEvents: props.filetypes ? props.filetypes.map(f => `onLanguage:${f}`) : ['*'],
        contributes: {
          configuration: {
            properties: {
              [`coc.source.${name}.enable`]: {
                type: 'boolean',
                default: true
              },
              [`coc.source.${name}.firstMatch`]: {
                type: 'boolean',
                default: !!props.firstMatch
              },
              [`coc.source.${name}.triggerCharacters`]: {
                type: 'number',
                default: props.triggerCharacters || []
              },
              [`coc.source.${name}.priority`]: {
                type: 'number',
                default: props.priority ?? 9
              },
              [`coc.source.${name}.shortcut`]: {
                type: 'string',
                default: props.shortcut ?? name.slice(0, 3).toUpperCase(),
                description: 'Shortcut text shown in complete menu.'
              },
              [`coc.source.${name}.disableSyntaxes`]: {
                type: 'array',
                default: [],
                items: {
                  type: 'string'
                }
              },
              [`coc.source.${name}.filetypes`]: {
                type: 'array',
                default: props.filetypes || null,
                description: 'Enabled filetypes.',
                items: {
                  type: 'string'
                }
              }
            }
          }
        }
      }
      let source = new VimSource({
        name,
        filepath,
        sourceType: SourceType.Remote,
        optionalFns: fns.filter(n => !['init', 'complete'].includes(n))
      })
      let isActive = false
      let extension: any = {
        id: packageJSON.name,
        packageJSON,
        exports: void 0,
        extensionPath: filepath,
        activate: () => {
          isActive = true
          this.addSource(source)
          return Promise.resolve()
        }
      }
      Object.defineProperty(extension, 'isActive', {
        get: () => isActive
      })
      void extensions.manager.registerInternalExtension(extension, () => {
        isActive = false
        this.removeSource(source)
      })
    } catch (e) {
      void window.showErrorMessage(`Error on create vim source ${name}: ${e}`)
    }
  }

  private createRemoteSources(): void {
    let { runtimepath } = workspace.env
    let paths = runtimepath.split(',')
    for (let path of paths) {
      this.createVimSources(path).logError()
    }
  }

  private async createVimSources(pluginPath: string): Promise<void> {
    if (this.remoteSourcePaths.includes(pluginPath)) return
    this.remoteSourcePaths.push(pluginPath)
    let folder = path.join(pluginPath, 'autoload/coc/source')
    let stat = await statAsync(folder)
    if (stat && stat.isDirectory()) {
      let arr = await util.promisify(fs.readdir)(folder)
      arr = arr.filter(s => s.endsWith('.vim'))
      let files = arr.map(s => path.join(folder, s))
      if (files.length == 0) return
      await Promise.all(files.map(p => this.createVimSourceExtension(this.nvim, p)))
    }
  }

  public get names(): string[] {
    return Array.from(this.sourceMap.keys())
  }

  public get sources(): ISource[] {
    return Array.from(this.sourceMap.values())
  }

  public has(name): boolean {
    return this.names.findIndex(o => o == name) != -1
  }

  public getSource(name: string): ISource | null {
    if (!name) return null
    return this.sourceMap.get(name) || null
  }

  public shouldCommit(item: ExtendedCompleteItem, commitCharacter: string): boolean {
    if (!item || !item.source) return false
    let source = this.getSource(item.source)
    if (source && typeof source.shouldCommit === 'function') {
      return source.shouldCommit(item, commitCharacter)
    }
    return false
  }

  public getCompleteSources(opt: CompleteOption): ISource[] {
    let { filetype } = opt
    let pre = byteSlice(opt.line, 0, opt.colnr - 1)
    let isTriggered = opt.input == '' && !!opt.triggerCharacter
    let uri = getUri(opt.filepath, opt.bufnr, '', workspace.env.isCygwin)
    if (isTriggered) return this.getTriggerSources(pre, filetype, uri)
    return this.getNormalSources(opt.filetype, uri)
  }

  /**
   * Get sources should be used without trigger.
   *
   * @param {string} filetype
   * @returns {ISource[]}
   */
  public getNormalSources(filetype: string, uri: string): ISource[] {
    let languageIds = filetype.split('.')
    return this.sources.filter(source => {
      let { filetypes, triggerOnly, documentSelector, enable } = source
      if (!enable || triggerOnly || (filetypes && !intersect(filetypes, languageIds))) {
        return false
      }
      if (documentSelector && languageIds.every(filetype => workspace.match(documentSelector, { uri, languageId: filetype }) == 0)) {
        return false
      }
      return true
    })
  }

  private checkTrigger(source: ISource, pre: string, character: string): boolean {
    let { triggerCharacters, triggerPatterns } = source
    if (triggerCharacters?.length > 0 && triggerCharacters.includes(character)) {
      return true
    }
    if (triggerPatterns?.length > 0 && triggerPatterns.findIndex(p => p.test(pre)) !== -1) {
      return true
    }
    return false
  }

  public shouldTrigger(pre: string, filetype: string, uri: string): boolean {
    return this.getTriggerSources(pre, filetype, uri).length > 0
  }

  public getTriggerSources(pre: string, filetype: string, uri: string, disabled: ReadonlyArray<string> = []): ISource[] {
    if (!pre) return []
    let character = pre[pre.length - 1]
    let languageIds = filetype.split('.')
    return this.sources.filter(source => {
      let { filetypes, enable, documentSelector, name } = source
      if (disabled.includes(name)) return false
      if (!enable || (filetypes && !intersect(filetypes, languageIds))) {
        return false
      }
      if (documentSelector && languageIds.every(languageId => workspace.match(documentSelector, { uri, languageId }) == 0)) {
        return false
      }
      return this.checkTrigger(source, pre, character)
    })
  }

  public addSource(source: ISource): Disposable {
    let { name } = source
    if (this.names.includes(name)) {
      logger.warn(`Recreate source ${name}`)
    }
    this.sourceMap.set(name, source)
    return Disposable.create(() => {
      this.sourceMap.delete(name)
    })
  }

  public removeSource(source: ISource | string): void {
    let name = typeof source == 'string' ? source : source.name
    this.sourceMap.delete(name)
  }

  public async refresh(name?: string): Promise<void> {
    for (let source of this.sources) {
      if (!name || source.name == name) {
        if (typeof source.refresh === 'function') {
          await Promise.resolve(source.refresh())
        }
      }
    }
  }

  public toggleSource(name: string): void {
    if (!name) return
    let source = this.getSource(name)
    if (!source) return
    if (typeof source.toggle === 'function') {
      source.toggle()
    }
  }

  public sourceStats(): SourceStat[] {
    let res: SourceStat[] = []
    let items = this.sources
    let doc = workspace.getDocument(workspace.bufnr)
    let suggest = workspace.getConfiguration('suggest', doc)
    let languageSourcePriority = suggest.get<number>('languageSourcePriority', 99)
    for (let item of items) {
      let priority = typeof item.priority === 'number' ? item.priority : item.sourceType == SourceType.Service ? languageSourcePriority : 0
      res.push({
        name: item.name,
        priority,
        triggerCharacters: item.triggerCharacters || [],
        shortcut: item.shortcut || '',
        filetypes: item.filetypes || [],
        filepath: item.filepath || '',
        type: item.sourceType == SourceType.Native
          ? 'native' : item.sourceType == SourceType.Remote
            ? 'remote' : 'service',
        disabled: !item.enable
      })
    }
    return res
  }

  private onDocumentEnter(bufnr: number): void {
    let { sources } = this
    for (let s of sources) {
      if (s.enable && typeof s.onEnter == 'function') {
        s.onEnter(bufnr)
      }
    }
  }

  public createSource(config: SourceConfig): Disposable {
    if (!config.name || !config.doComplete) {
      throw new Error(`name and doComplete required for createSource`)
    }
    let source = new Source(Object.assign({ sourceType: SourceType.Service } as any, config))
    return this.addSource(source)
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}

export default new Sources()
