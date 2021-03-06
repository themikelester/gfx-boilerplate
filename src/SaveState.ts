import { CameraSystem } from "./CameraSystem";
import { defined } from "./util";
import { DebugMenu } from "./DebugMenu";
import { IS_DEVELOPMENT } from "./version";

const kStateVersion = 1;
const kStateStorageKey = 'state';

type StateModules = {
    cameraSystem: CameraSystem,
    debugMenu: DebugMenu,
}

export class StateManager {
    clearing: boolean = false;

    initialize(modules: StateModules) {
        modules.debugMenu.add(this, 'clearState');

        const success = this.loadState(modules);
        if (success) console.log('Loaded state from localStorage');
    }

    saveState({ cameraSystem, debugMenu }: StateModules): void {
        const stateObj = {
            version: kStateVersion,
            cameraSystem,
            debugMenu, 
        }
    
        const stateString = JSON.stringify(stateObj);

        // If clearState() has been called, ensure we don't save state until the page finishes reloading
        if (this.clearing) return; 

        window.localStorage.setItem(kStateStorageKey, stateString);
    }
    
    loadState({ cameraSystem, debugMenu }: StateModules): boolean {
        const stateString = window.localStorage.getItem(kStateStorageKey);
        if (!defined(stateString)) { return false; }
        
        const state = JSON.parse(stateString);
        
        // Don't bother trying to load older state formats
        if (state.version !== kStateVersion) return false;
    
        try {
            cameraSystem.fromJSON(state.cameraSystem);
            debugMenu.fromJSON(state.debugMenu);
        } catch(e) {
            console.warn('Failed to load state:', e);
            return false;
        }
        
        return true
    }

    clearState() {
        window.localStorage.removeItem(kStateStorageKey);
        this.clearing = true;
        location.reload();
    }

    update(modules: StateModules) {
        if (IS_DEVELOPMENT) {
            this.saveState(modules);
        }
    }
}