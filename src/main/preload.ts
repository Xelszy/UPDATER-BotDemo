
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
    send: (channel: string, data: any) => {
        let validChannels = ['login-manual', 'login-cookies', 'start-boost', 'start-scrape', 'start-debug', 'run-csv-campaign', 'run-cookie-campaign', 'check-update', 'run-update'];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    on: (channel: string, func: (...args: any[]) => void) => {
        let validChannels = ['log-message', 'status-update', 'account-status', 'campaign-done', 'version-info', 'update-status'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },
    invoke: (channel: string, data?: any): Promise<any> => {
        let validChannels = ['get-version'];
        if (validChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
        return Promise.reject(new Error(`Invalid invoke channel: ${channel}`));
    },
});
