const https = require('https');
const http = require('http');
const fs = require('fs');

const GITHUB_OWNER = 'Xelszy';
const GITHUB_REPO = 'UPDATER-BotDemo';

function getZipUrl() {
    return new Promise((resolve) => {
        https.get(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
            headers: { 'User-Agent': 'Botting-Updater' }
        }, (res) => {
            let data = '';
            res.on('data', c => data+=c);
            res.on('end', () => resolve(JSON.parse(data).zipball_url));
        });
    });
}

function download(url, redirects = 0) {
    if (redirects > 5) return console.log('Too many redirects');
    console.log(`GET ${url}`);
    const protocol = url.startsWith('https:') ? https : http;
    protocol.get(url, {
        headers: {
            'User-Agent': 'Botting-Updater'
        }
    }, (res) => {
        console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
        console.log(`Headers:`, res.headers);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return download(res.headers.location, redirects + 1);
        }
        res.on('data', () => {});
    });
}

getZipUrl().then(url => {
    if(url) download(url);
    else console.log('No zipball url');
});
