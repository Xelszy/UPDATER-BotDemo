import https from 'https';
import http from 'http';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';

// ============================================================
// CONFIGURE YOUR GITHUB REPO HERE
// ============================================================
const GITHUB_OWNER = 'Xelszy';                 // <-- Ganti dengan username GitHub kamu
const GITHUB_REPO = 'UPDATER-BotDemo';         // <-- Ganti dengan nama repo kamu
// ============================================================

export interface UpdateInfo {
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
    downloadUrl: string;
    releaseNotes: string;
    publishedAt: string;
}

export class UpdateService {
    private logCallback: ((msg: string) => void) | null = null;

    setLogger(callback: (msg: string) => void) {
        this.logCallback = callback;
    }

    private log(msg: string) {
        console.log(msg);
        if (this.logCallback) this.logCallback(msg);
    }

    /**
     * Get current app version from package.json
     */
    getCurrentVersion(): string {
        try {
            const pkgPath = path.join(app.getAppPath(), 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = fs.readJsonSync(pkgPath);
                return pkg.version || '0.0.0';
            }
            // Fallback: try from project root
            const rootPkg = path.join(process.cwd(), 'package.json');
            if (fs.existsSync(rootPkg)) {
                const pkg = fs.readJsonSync(rootPkg);
                return pkg.version || '0.0.0';
            }
        } catch (e) {
            console.error('Failed to read version:', e);
        }
        return '0.0.0';
    }

    /**
     * Check GitHub releases for a newer version.
     */
    async checkForUpdate(): Promise<UpdateInfo> {
        const currentVersion = this.getCurrentVersion();
        this.log(`🔍 [UPDATE] Current version: ${currentVersion}`);
        this.log(`🔍 [UPDATE] Checking ${GITHUB_OWNER}/${GITHUB_REPO}...`);

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
                method: 'GET',
                headers: {
                    'User-Agent': 'Botting-Updater',
                    'Accept': 'application/vnd.github.v3+json',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        if (res.statusCode === 404) {
                            this.log('⚠️ [UPDATE] No releases found on GitHub.');
                            resolve({
                                hasUpdate: false,
                                currentVersion,
                                latestVersion: currentVersion,
                                downloadUrl: '',
                                releaseNotes: 'No releases found.',
                                publishedAt: '',
                            });
                            return;
                        }

                        const release = JSON.parse(data);
                        const latestVersion = (release.tag_name || '').replace(/^v/, '');
                        const hasUpdate = this.compareVersions(latestVersion, currentVersion) > 0;

                        // Find the zip download URL (source code zip)
                        const downloadUrl = release.zipball_url || '';

                        this.log(`📦 [UPDATE] Latest: ${latestVersion} | Current: ${currentVersion} | ${hasUpdate ? '🆕 Update available!' : '✅ Up to date'}`);

                        resolve({
                            hasUpdate,
                            currentVersion,
                            latestVersion,
                            downloadUrl,
                            releaseNotes: release.body || 'No release notes.',
                            publishedAt: release.published_at || '',
                        });
                    } catch (e: any) {
                        this.log(`❌ [UPDATE] Parse error: ${e.message}`);
                        reject(e);
                    }
                });
            });

            req.on('error', (e) => {
                this.log(`❌ [UPDATE] Network error: ${e.message}`);
                reject(e);
            });

            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * Download the latest release zip and replace project files.
     */
    async downloadAndInstall(downloadUrl: string): Promise<boolean> {
        if (!downloadUrl) {
            this.log('❌ [UPDATE] No download URL provided.');
            return false;
        }

        const tempDir = path.join(app.getPath('temp'), 'botting-update');
        const zipPath = path.join(tempDir, 'update.zip');
        const extractDir = path.join(tempDir, 'extracted');
        const projectRoot = process.cwd();

        try {
            // 1. Prepare temp directory
            await fs.ensureDir(tempDir);
            await fs.emptyDir(tempDir);
            this.log('📁 [UPDATE] Temp directory ready.');

            // 2. Download zip
            this.log(`⬇️ [UPDATE] Downloading from GitHub...`);
            await this.downloadFile(downloadUrl, zipPath);
            this.log('✅ [UPDATE] Download complete.');

            // 3. Extract zip
            this.log('📦 [UPDATE] Extracting...');
            await this.extractZip(zipPath, extractDir);
            this.log('✅ [UPDATE] Extraction complete.');

            // 4. Find the extracted folder (GitHub adds a folder like owner-repo-hash/)
            const entries = await fs.readdir(extractDir);
            const innerDir = entries.length === 1
                ? path.join(extractDir, entries[0])
                : extractDir;

            // 5. Replace project files
            this.log('🔄 [UPDATE] Replacing project files...');
            const filesToReplace = ['src', 'package.json', 'build.js', 'tsconfig.json'];

            for (const item of filesToReplace) {
                const sourcePath = path.join(innerDir, item);
                const destPath = path.join(projectRoot, item);

                if (await fs.pathExists(sourcePath)) {
                    // Backup old file/dir
                    const backupPath = path.join(tempDir, `backup_${item}`);
                    if (await fs.pathExists(destPath)) {
                        await fs.copy(destPath, backupPath);
                    }

                    // Replace
                    await fs.remove(destPath);
                    await fs.copy(sourcePath, destPath);
                    this.log(`  ✅ Replaced: ${item}`);
                } else {
                    this.log(`  ⏭️ Skipped (not in update): ${item}`);
                }
            }

            // 6. Cleanup temp
            await fs.remove(tempDir);
            this.log('🧹 [UPDATE] Temp files cleaned.');
            this.log('✅ [UPDATE] Update complete! Restart the app to apply changes.');

            return true;
        } catch (e: any) {
            this.log(`❌ [UPDATE] Error: ${e.message}`);
            return false;
        }
    }

    /**
     * Download a file from URL, following redirects.
     */
    private downloadFile(url: string, destPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const makeRequest = (reqUrl: string, redirectCount: number = 0) => {
                this.log(`⬇️ [UPDATE] GET ${reqUrl}`);
                if (redirectCount > 5) {
                    reject(new Error('Too many redirects'));
                    return;
                }

                const parsedUrl = new URL(reqUrl);
                const protocol = parsedUrl.protocol === 'https:' ? https : http;

                // Only send User-Agent. Many servers (like codeload.github.com) 
                // reject requests with 415 if they don't like the Accept header.
                const req = protocol.get(reqUrl, {
                    headers: {
                        'User-Agent': 'Botting-Updater',
                    },
                }, (res) => {
                    this.log(`⬇️ [UPDATE] Download status: ${res.statusCode} ${res.statusMessage}`);
                    
                    // Follow redirects
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        this.log(`⬇️ [UPDATE] Redirecting to: ${res.statusCode} -> ${res.headers.location}`);
                        makeRequest(res.headers.location, redirectCount + 1);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        reject(new Error(`Download failed: HTTP ${res.statusCode} ${res.statusMessage}`));
                        return;
                    }

                    const fileStream = fs.createWriteStream(destPath);
                    res.pipe(fileStream);
                    
                    fileStream.on('finish', () => {
                        fileStream.close();
                        resolve();
                    });
                    
                    fileStream.on('error', (err) => {
                        this.log(`❌ [UPDATE] File write error: ${err.message}`);
                        reject(err);
                    });
                });

                req.on('error', (err) => {
                    this.log(`❌ [UPDATE] Request error: ${err.message}`);
                    reject(err);
                });
                
                req.setTimeout(60000, () => {
                    req.destroy();
                    reject(new Error('Download timeout'));
                });
            };

            makeRequest(url);
        });
    }

    /**
     * Extract a zip file using Node.js built-in (no external deps).
     * Uses child_process to call PowerShell's Expand-Archive on Windows.
     */
    private async extractZip(zipPath: string, destDir: string): Promise<void> {
        await fs.ensureDir(destDir);

        const { exec } = require('child_process');
        return new Promise((resolve, reject) => {
            // Use PowerShell Expand-Archive on Windows
            const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
            exec(cmd, { timeout: 60000 }, (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(new Error(`Extract failed: ${error.message}`));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Compare two semver version strings.
     * Returns >0 if a > b, <0 if a < b, 0 if equal.
     */
    private compareVersions(a: string, b: string): number {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] || 0;
            const nb = pb[i] || 0;
            if (na > nb) return 1;
            if (na < nb) return -1;
        }
        return 0;
    }
}
