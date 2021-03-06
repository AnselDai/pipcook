import { provide, inject } from 'midway';
import { PluginPackage, BootstrapArg, PluginRunnable, InstallOptions } from '@pipcook/costa';
import { PluginStatus, generateId } from '@pipcook/pipcook-core';
import { TraceManager, Tracer } from './trace-manager';
import PluginRuntime from '../boot/plugin';
import { PluginModelStatic, PluginModel } from '../model/plugin';
import { PluginResp, TraceResp } from '../interface';
import { pluginQueue } from '../utils';

interface ListPluginsFilter {
  datatype?: string;
  category?: string;
  name?: string;
}

@provide('pluginManager')
export class PluginManager {

  @inject('traceManager')
  traceManager: TraceManager;

  @inject('pluginModel')
  model: PluginModelStatic;

  @inject('pluginRT')
  pluginRT: PluginRuntime;

  get datasetRoot() {
    return this.pluginRT.costa.options.datasetDir;
  }

  async fetch(name: string): Promise<PluginPackage> {
    return this.pluginRT.costa.fetch(name);
  }

  /**
   * fetch pakcage info by plugin name
   * @param name plugin name
   */
  async fetchFromInstalledPlugin(name: string): Promise<PluginPackage> {
    return this.pluginRT.costa.fetchFromInstalledPlugin(name);
  }
  async fetchByStream(stream: NodeJS.ReadableStream): Promise<PluginPackage> {
    return this.pluginRT.costa.fetchByStream(stream);
  }

  async fetchAndInstall(name: string, tracer: Tracer, pyIndex?: string): Promise<PluginPackage> {
    const pkg = await this.fetch(name);
    const plugin = await this.findOrCreateByPkg(pkg);
    if (plugin.status !== PluginStatus.INSTALLED) {
      try {
        await this.install(plugin.id, pkg, { pyIndex, force: false, ...tracer.getLogger() });
        this.setStatusById(plugin.id, PluginStatus.INSTALLED);
      } catch (err) {
        this.setStatusById(plugin.id, PluginStatus.FAILED, err.message);
        throw err;
      }
    }
    return pkg;
  }

  async createRunnable(id: string, tracer: Tracer): Promise<PluginRunnable> {
    return this.pluginRT.costa.createRunnable({ id, logger: tracer.getLogger() } as BootstrapArg);
  }

  async list(filter?: ListPluginsFilter): Promise<PluginModel[]> {
    const where = {} as any;
    if (filter?.category) {
      where.category = filter.category;
    }
    if (filter?.datatype) {
      where.datatype = filter.datatype;
    }
    if (filter?.name) {
      where.name = filter.name;
    }
    return this.model.findAll({ where });
  }

  async query(filter?: ListPluginsFilter): Promise<PluginModel[]> {
    const where = {} as any;
    if (filter.category) {
      where.category = filter.category;
    }
    if (filter.datatype) {
      where.datatype = filter.datatype;
    }
    return this.model.findAll({ where });
  }

  async findById(id: string): Promise<PluginModel> {
    return this.model.findOne({ where: { id } });
  }

  async findByIds(ids: string[]): Promise<PluginModel[]> {
    return this.model.findAll({ where: { id: ids } });
  }
  async findByName(name: string): Promise<PluginModel> {
    return this.model.findOne({ where: { name } });
  }

  async removeById(id: string): Promise<number> {
    return this.model.destroy({ where: { id } });
  }

  async setStatusById(id: string, status: PluginStatus, errMsg?: string): Promise<number> {
    const [ count ] = await this.model.update({
      status,
      error: errMsg
    }, {
      where: { id }
    });
    return count;
  }

  async findOrCreateByPkg(pkg: PluginPackage): Promise<PluginModel> {
    const [ plugin ] = await this.model.findOrCreate({
      where: {
        // TODO(feely): support the different versions of plugins
        name: pkg.name
      },
      defaults: {
        id: generateId(),
        name: pkg.name,
        version: pkg.version,
        category: pkg.pipcook.category,
        datatype: pkg.pipcook.datatype,
        dest: pkg.pipcook.target.DESTPATH,
        sourceFrom: pkg.pipcook.source.from,
        sourceUri: pkg.pipcook.source.uri,
        status: PluginStatus.INITIALIZED
      }
    });
    return plugin;
  }

  async install(pluginId: string, pkg: PluginPackage, opts: InstallOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      pluginQueue.push((cb) => {
        this.setStatusById(pluginId, PluginStatus.INSTALLING);
        this.pluginRT.costa.install(pkg, opts).then(() => {
          resolve();
          cb();
        }).catch((err) => {
          // uninstall if occurring an error on installing.
          this.pluginRT.costa.uninstall(pkg);
          reject(err);
          cb();
        });
      });
    });
  }

  async installAtNextTick(pkg: PluginPackage, pyIndex?: string, force?: boolean): Promise<TraceResp<PluginResp>> {
    const plugin = await this.findOrCreateByPkg(pkg);
    if (plugin.status !== PluginStatus.INSTALLED) {
      const tracer = await this.traceManager.create();
      process.nextTick(async () => {
        try {
          this.setStatusById(plugin.id, PluginStatus.PENDING);
          await this.install(plugin.id, pkg, { pyIndex, force, ...tracer.getLogger() });
          this.setStatusById(plugin.id, PluginStatus.INSTALLED);
          this.traceManager.destroy(tracer.id);
        } catch (err) {
          this.setStatusById(plugin.id, PluginStatus.FAILED, err.message);
          console.error('install plugin error', err.message);
          this.traceManager.destroy(tracer.id, err);
        }
      });
      return { ...(plugin.toJSON() as PluginResp), traceId: tracer.id };
    } else {
      return { ...(plugin.toJSON() as PluginResp), traceId: '' };
    }
  }
  /**
   * install by package name or tarball url or git url
   * @param pkgName string package name, tarball url, git url
   * @param pyIndex string python package index
   * @param force boolean if true, the installed plugin will be reinstall
   */
  async installByName(pkgName: string, pyIndex?: string, force?: boolean): Promise<TraceResp<PluginResp>> {
    const pkg = await this.fetch(pkgName);
    return this.installAtNextTick(pkg, pyIndex, force);
  }

  async uninstall(plugin: PluginModel | PluginModel[]): Promise<void> {
    const { costa } = this.pluginRT;
    if (Array.isArray(plugin)) {
      const plugins = plugin.map(plugin => plugin.toJSON() as PluginModel);
      await costa.uninstall(plugins);
      await plugin.map(async (singlePlugin) => {
        await singlePlugin.destroy();
      });
    } else {
      await costa.uninstall(plugin);
      await plugin.destroy();
    }
  }

  async installFromTarStream(tarball: NodeJS.ReadableStream, pyIndex?: string, force?: boolean): Promise<TraceResp<PluginResp>> {
    const pkg = await this.fetchByStream(tarball);
    return this.installAtNextTick(pkg, pyIndex, force);
  }
}
