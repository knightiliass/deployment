// backend/src/utils/fileUtils.js
const https = require('https');
const fs = require('fs');

function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        
        https.get(url, response => {
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloaded = 0;

            response.on('data', chunk => {
                downloaded += chunk.length;
                const progress = Math.round((downloaded * 100) / totalSize);
                onProgress(progress);
            });

            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', err => {
            fs.unlink(destPath, () => reject(err));
        });
    });
}

module.exports = {
    downloadFile
};