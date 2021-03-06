import ConfigStore from 'configstore';
import * as R from '../../lib/ramda.min';
import {RpsContext,RpsModuleModel,RpsActionModel} from 'rpscript-interface';
import {KeywordsMgr} from './keywordsmgr';
import {NpmModHelper} from '../helper/npmMod';
import { EventEmitter } from 'events';
import deasyncPromise from 'deasync-promise';

const HOMEDIR = require('os').homedir();

export class ModuleMgr {
    readonly CONFIG_NAME = "rpscript";
    readonly NPM_MOD_PREFIX = "rpscript-api-";
    readonly NPM_MOD_ORG_PREFIX = "@typecasting/rpscript-api-";

    static readonly MOD_INSTALLED_NPM_EVT = "runner.module.installed.npm";
    static readonly MOD_INSTALLED_CONFIG_EVT = "runner.module.installed.config";
    static readonly MOD_INSTALLED_ERROR_EVT = "runner.module.installed.error";

    static readonly MOD_REMOVED_NPM_EVT = "runner.module.removed.npm";
    static readonly MOD_REMOVED_CONFIG_EVT = "runner.module.removed.config";
    static readonly MOD_REMOVED_ERROR_EVT = "runner.module.removed.error";

    static readonly MOD_LOADED_EVT = "runner.module.loaded";
    static readonly MOD_DISABLED_EVT = "runner.module.disabled";
    static readonly MOD_LOAD_ERROR_EVT = "runner.module.load.error";
    // static readonly ACTION_LOAD_ERROR_EVT = "action.module.load.error";

    configStore:ConfigStore;

    wordMgr:KeywordsMgr;
    event:EventEmitter;

    constructor() {
        this.configStore = new ConfigStore(this.CONFIG_NAME);
        this.wordMgr = new KeywordsMgr;
        this.event = new EventEmitter;
    }

    async installModule (npmModuleName:string,allowExtModule?:boolean) :Promise<RpsModuleModel> {

        try{
            let prefix = allowExtModule ? this.NPM_MOD_PREFIX : this.NPM_MOD_ORG_PREFIX;
            
            if(!npmModuleName.trim().startsWith(prefix)) npmModuleName = prefix + npmModuleName.trim();

            let installedInfo = await this.installFromNpm(npmModuleName);

            this.event.emit(ModuleMgr.MOD_INSTALLED_NPM_EVT, installedInfo);
    

            //save module info
            this.configStore.set(installedInfo['name'],{
                name:installedInfo['name'],
                npmModuleName:installedInfo['npmModuleName'],
                npmVersion:installedInfo['version'],
                enabled:true
            });

            //save keywords info
            this.wordMgr.saveModuleKeywords(installedInfo['name'] , installedInfo['clazz']);

            let modInfo:RpsModuleModel = this.configStore.get(installedInfo['name']);

            this.event.emit(ModuleMgr.MOD_INSTALLED_CONFIG_EVT, modInfo);

            
            return modInfo;

        }catch(err){
            this.event.emit(ModuleMgr.MOD_INSTALLED_ERROR_EVT,err);
            throw err;
        }
    }

    private async installFromNpm (npmModuleName) : Promise<Object> {
        let result = NpmModHelper.installNpmModule(npmModuleName);

        const mod = await import(`${HOMEDIR}/.rpscript/modules/node_modules/${result.moduleName}`);
        let modClazz = mod.default;
        let moduleName = modClazz['rpsModuleName'];

        return {clazz:modClazz,name:moduleName,version:result.version,npm:result,npmModuleName:result.moduleName};
    }


    async removeModule (moduleName:string) : Promise<void>{
        try{
            let npmModuleName = this.getModuleNpmName(moduleName);

            let removeInfo = NpmModHelper.removeNpmModule(npmModuleName);

            this.event.emit(ModuleMgr.MOD_REMOVED_NPM_EVT,removeInfo);


            let removedMod = this.removeModuleConfig(npmModuleName);

            this.wordMgr.removeModuleDefaults(removedMod['name']);


            this.event.emit(ModuleMgr.MOD_REMOVED_CONFIG_EVT,removedMod);

        }catch(err){
            this.event.emit(ModuleMgr.MOD_REMOVED_ERROR_EVT,err);
            throw err;
        }
    }
    private removeModuleConfig (npmModuleName:string) : RpsModuleModel{
        let all = this.configStore.all;

        let output = R.values(all);
        //npm name and module name assume to be different
        let modConfig:RpsModuleModel = R.find( R.propEq('npmModuleName', npmModuleName)  , output );
    
        this.configStore.delete(modConfig['name']);
        
        return modConfig;
    }

    listModuleNames () : string[]{ return R.keys(this.configStore.all); }
    listInstalledModules () : Object{ return this.configStore.all; }
    listAvailableModules () : Object{ return {}; }

    async loadModuleObjs (rpsContext:RpsContext,modules?:string[]) : Promise<Object>{
        let allModules:Object = this.configStore.all;
        let moduleNames = R.filter( m => m!=='$DEFAULT', R.keys(allModules));

        let moduleObj:Object = {};

        for(let i =0;i<moduleNames.length;i++){
            let module = allModules[ moduleNames[i] ];
            let moduleName = module.npmModuleName;

            let skip:boolean = modules? !R.any(R.identical(moduleNames[i]),modules) : false;

            if(module.enabled && !skip) {
                let mod = await import (`${HOMEDIR}/.rpscript/modules/node_modules/${moduleName}`);

                moduleObj[ moduleNames[i] ] = new mod.default(rpsContext);

                this.event.emit(ModuleMgr.MOD_LOADED_EVT,moduleNames[i]);
            }else {
                this.event.emit(ModuleMgr.MOD_DISABLED_EVT,moduleNames[i]);
            }
        }

        moduleObj['api'] = this.genDefaultApi(moduleObj,rpsContext);

        return moduleObj;
    }

    // api(keyword, $CONTEXT , {} , "12121");
    private genDefaultApi (modObj:Object,rpsContext:RpsContext) : Function{

        return (keyword:string, ctx:RpsContext, opt:Object,  ...params) => {

            let actions:RpsActionModel[] = rpsContext.getRuntimeDefault()[keyword];

            let bestFit:RpsActionModel = this.wordMgr.selectBestFitByPriority (actions);

            let args = [ctx,opt].concat(params);

            let moduleUse = bestFit.moduleName;
            if(opt['module']) moduleUse = opt['module'];

            let promise = modObj[moduleUse][bestFit.methodName].apply(this,args);

            return deasyncPromise(promise);
        }
    }

    private getModuleNpmName(moduleName:string) :string {
        let npmName = this.configStore.all[moduleName]['npmModuleName'];

        return npmName;
    }



}
