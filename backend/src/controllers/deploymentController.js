// backend/src/controllers/deploymentController.js
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { downloadFile } = require('../utils/fileUtils');
const { generatePowershellScript } = require('../utils/scriptUtils');

let deployments = new Map();

const deploymentController = {
    startDeployment: async (req, res) => {
        const { computers, installerUrl } = req.body;
        
        if (!computers || !Array.isArray(computers) || computers.length === 0) {
            return res.status(400).json({ error: 'Invalid computer list' });
        }

        const deploymentId = Date.now().toString();
        const deploymentStatus = {
            id: deploymentId,
            startTime: new Date(),
            computers: computers.map(computer => ({
                name: computer,
                status: 'downloading',
                downloadProgress: 0,
                robotStatus: 'pending',
                startTime: new Date(),
                endTime: null,
                details: null
            }))
        };

        deployments.set(deploymentId, deploymentStatus);

        // Process each computer
        computers.forEach(async computer => {
            const computerStatus = deploymentStatus.computers.find(c => c.name === computer);
            const tempPath = path.join(__dirname, `../../temp/${computer}_installer.exe`);

            try {
                await downloadFile(installerUrl, tempPath, (progress) => {
                    computerStatus.downloadProgress = progress;
                });

                computerStatus.status = 'installing';
                computerStatus.downloadProgress = 100;

                const scriptContent = generatePowershellScript(computer, tempPath);
                const scriptPath = path.join(__dirname, `../../temp/${computer}_install.ps1`);
                await fs.writeFile(scriptPath, scriptContent);

                exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, async (error, stdout, stderr) => {
                    computerStatus.endTime = new Date();
                    
                    if (error) {
                        computerStatus.status = 'failed';
                        computerStatus.details = stderr || error.message;
                        computerStatus.robotStatus = 'failed';
                    } else {
                        computerStatus.status = 'success';
                        computerStatus.details = stdout || 'Installation completed successfully';
                        computerStatus.robotStatus = 'running';
                    }

                    // Cleanup
                    try {
                        await fs.unlink(tempPath);
                        await fs.unlink(scriptPath);
                    } catch (cleanupError) {
                        console.error('Cleanup error:', cleanupError);
                    }
                });
            } catch (error) {
                computerStatus.status = 'failed';
                computerStatus.details = error.message;
                computerStatus.robotStatus = 'failed';
                computerStatus.endTime = new Date();
            }
        });

        res.json({ deploymentId });
    },

    getDeploymentStatus: (req, res) => {
        const deployment = deployments.get(req.params.id);
        if (!deployment) {
            return res.status(404).json({ error: 'Deployment not found' });
        }
        res.json(deployment);
    },

    getAllDeployments: (req, res) => {
        const allDeployments = Array.from(deployments.values());
        res.json(allDeployments);
    }
};

module.exports = deploymentController;