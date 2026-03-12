import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';
import { BrowserContext } from 'playwright';

export class SessionService {
    private sessionsDir: string;

    constructor() {
        this.sessionsDir = path.join(app.getPath('userData'), 'sessions');
        fs.ensureDirSync(this.sessionsDir);
    }

    async saveSession(profileId: string, context: BrowserContext) {
        const storageState = await context.storageState();
        const filePath = path.join(this.sessionsDir, `${profileId}.json`);
        await fs.writeJson(filePath, storageState);
        console.log(`Session saved for profile: ${profileId}`);
    }

    async loadSession(profileId: string): Promise<string | undefined> {
        const filePath = path.join(this.sessionsDir, `${profileId}.json`);
        if (await fs.pathExists(filePath)) {
            console.log(`Session found for profile: ${profileId}`);
            return filePath;
        }
        console.log(`No session found for profile: ${profileId}`);
        return undefined;
    }
}
