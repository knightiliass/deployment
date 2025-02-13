const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
// Serve static files from the "public" folder
app.use(express.static('public'));

let deployments = new Map();

app.post('/api/get-computer-info', async (req, res) => {
    const { computers } = req.body;
    
    if (!computers || !Array.isArray(computers) || computers.length === 0) {
        return res.status(400).json({ error: 'Invalid computer list' });
    }

    console.log('Checking versions for computers:', computers);
    
    const versionChecks = await Promise.all(computers.map(async (computer) => {
        const checkScript = `
            $ErrorActionPreference = 'Continue'
            $result = @{
                ComputerName = '${computer}'
                IsReachable = $false
                Version = $null
                InstallPath = $null
                IsInstalled = $false
                Error = $null
            }

            try {
                $securePassword = ConvertTo-SecureString 't73fhT3a' -AsPlainText -Force
                $credentials = New-Object System.Management.Automation.PSCredential ('SNILP80', $securePassword)
                
                Write-Output "Checking computer ${computer}..."
                
                if (Test-Connection -ComputerName ${computer} -Count 1 -Quiet) {
                    $result.IsReachable = $true
                    
                    $session = New-PSSession -ComputerName ${computer} -Credential $credentials -ErrorAction Stop
                    
                    if ($session) {
                        $softwareInfo = Invoke-Command -Session $session -ScriptBlock {
                            $registryPath = "HKLM:\\SOFTWARE\\IP-LABEL\\INSTALL\\DFYRobotServices"
                            
                            try {
                                if (Test-Path $registryPath) {
                                    $regInfo = Get-ItemProperty -Path $registryPath -ErrorAction Stop
                                    Write-Output "Found registry entry: $($regInfo | ConvertTo-Json)"
                                    return @{
                                        IsInstalled = $true
                                        Version = $regInfo.Version
                                        InstallPath = $regInfo.BasePath
                                        Error = $null
                                    }
                                } else {
                                    Write-Output "Registry path not found: $registryPath"
                                    return @{
                                        IsInstalled = $false
                                        Version = $null
                                        InstallPath = $null
                                        Error = "Registry path not found"
                                    }
                                }
                            } catch {
                                Write-Output "Error accessing registry: $_"
                                return @{
                                    IsInstalled = $false
                                    Version = $null
                                    InstallPath = $null
                                    Error = $_.Exception.Message
                                }
                            }
                        }
                        
                        Remove-PSSession $session
                        
                        $result.IsInstalled = $softwareInfo.IsInstalled
                        $result.Version = $softwareInfo.Version
                        $result.InstallPath = $softwareInfo.InstallPath
                        $result.Error = $softwareInfo.Error
                    }
                } else {
                    $result.Error = "Computer is not reachable"
                }
            }
            catch {
                $result.Error = $_.Exception.Message
                Write-Output "Error: $_"
            }
            
            Write-Output "JSON_START"
            ConvertTo-Json -InputObject $result -Compress
            Write-Output "JSON_END"
        `;
        
        const tempScript = path.join(os.tmpdir(), `version_check_${computer}_${Date.now()}.ps1`);
        
        try {
            fs.writeFileSync(tempScript, checkScript);
            
            return new Promise((resolve) => {
                exec(
                    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tempScript}"`,
                    { maxBuffer: 1024 * 1024 * 10 },
                    (error, stdout, stderr) => {
                        // Clean up temp file
                        try {
                            fs.unlinkSync(tempScript);
                        } catch (e) {
                            console.error('Error deleting temp file:', e);
                        }

                        try {
                            console.log('Raw output:', stdout);
                            const match = stdout.match(/JSON_START\r?\n(.*?)\r?\nJSON_END/s);
                            if (match && match[1]) {
                                const result = JSON.parse(match[1].trim());
                                console.log(`Result for ${computer}:`, result);
                                resolve(result);
                            } else {
                                throw new Error('No valid JSON found');
                            }
                        } catch (e) {
                            console.error(`Error parsing output for ${computer}:`, e);
                            resolve({
                                ComputerName: computer,
                                IsReachable: false,
                                Version: null,
                                InstallPath: null,
                                IsInstalled: false,
                                Error: 'Failed to get software information'
                            });
                        }
                    }
                );
            });
        } catch (e) {
            console.error(`Error checking ${computer}:`, e);
            return {
                ComputerName: computer,
                IsReachable: false,
                Version: null,
                InstallPath: null,
                IsInstalled: false,
                Error: e.message
            };
        }
    }));

    res.json({
        timestamp: new Date(),
        computers: versionChecks
    });
});

// Check connectivity
async function checkComputerConnection(computer, username = 'SNILP80', password = 't73fhT3a') {
    return new Promise((resolve) => {
        const checkScript = `
            $ErrorActionPreference = 'Continue'
            try {
                Write-Output "Testing WinRM connectivity..."
                Test-WSMan -ComputerName ${computer} -ErrorAction Stop | Out-Null
                
                Write-Output "Setting up credentials..."
                $securePassword = ConvertTo-SecureString '${password}' -AsPlainText -Force
                $credentials = New-Object System.Management.Automation.PSCredential ('${username}', $securePassword)
                
                Write-Output "Testing remote session..."
                $session = New-PSSession -ComputerName ${computer} -Credential $credentials -ErrorAction Stop
                if ($session) {
                    Remove-PSSession $session
                    exit 0
                }
                exit 1
            } catch {
                Write-Output "Connection test failed: $_"
                exit 1
            }
        `;
        
        const tempScript = path.join(os.tmpdir(), `check_${computer}_${Date.now()}.ps1`);
        fs.writeFileSync(tempScript, checkScript);
        
        exec(
            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tempScript}"`,
            (error, stdout) => {
                try {
                    fs.unlinkSync(tempScript);
                } catch (cleanupError) {
                    console.error('Cleanup error:', cleanupError);
                }

                if (error) {
                    console.log(`Connection test output for ${computer}:`, stdout);
                }
                resolve(!error);
            }
        );
    });
}

// Create deployment script
function createDeployScript(computer, installerUrl, username = 'SNILP80', password = 't73fhT3a') {
    return `
$ErrorActionPreference = 'Continue'
$VerbosePreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Write-Progress-Update($Message, $PercentComplete) {
    Write-Output "PROGRESS: $(@{ Message = $Message; Percent = $PercentComplete } | ConvertTo-Json -Compress)"
}

try {
    Write-Progress-Update "Setting up credentials..." 5
    $securePassword = ConvertTo-SecureString '${password}' -AsPlainText -Force
    $credentials = New-Object System.Management.Automation.PSCredential ('${username}', $securePassword)

    Write-Progress-Update "Creating remote session..." 10
    $sessionOptions = New-PSSessionOption -NoMachineProfile -OpenTimeout 60000 -OperationTimeout 1800000
    $session = New-PSSession -ComputerName ${computer} -Credential $credentials -SessionOption $sessionOptions -ErrorAction Stop

    Write-Progress-Update "Starting remote installation..." 15
    $result = Invoke-Command -Session $session -ScriptBlock {
        param($url)
        $ErrorActionPreference = 'Continue'

        try {
            Write-Output "PROGRESS: $(@{ Message = 'Setting up installation directory...'; Percent = 25 } | ConvertTo-Json -Compress)"
            $tempDir = "C:\\Windows\\Temp\\install_$(Get-Random)"
            $installerPath = Join-Path $tempDir "installer.exe"
            
            if (-not (Test-Path "C:\\Windows\\Temp")) {
                throw "Cannot access Temp directory"
            }
            
            New-Item -Path $tempDir -ItemType Directory -Force | Out-Null
            
            Write-Output "PROGRESS: $(@{ Message = 'Starting download...'; Percent = 35 } | ConvertTo-Json -Compress)"
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            
            $webClient = New-Object System.Net.WebClient
            $webClient.Headers.Add("User-Agent", "PowerShell Deployment Script")
            
            try {
                Write-Output "PROGRESS: $(@{ Message = 'Downloading installer...'; Percent = 45 } | ConvertTo-Json -Compress)"
                $webClient.DownloadFile($url, $installerPath)
                Write-Output "PROGRESS: $(@{ Message = 'Download completed'; Percent = 60 } | ConvertTo-Json -Compress)"
            }
            catch {
                throw "Download failed: $($_.Exception.Message)"
            }

            if (Test-Path $installerPath) {
                Write-Output "PROGRESS: $(@{ Message = 'Starting installation...'; Percent = 70 } | ConvertTo-Json -Compress)"
                $silentParams = @(
                    @("/S"),
                    @("/quiet"),
                    @("/silent"),
                    @("/verysilent", "/suppressmsgboxes"),
                    @("/qn"),
                    @("-silent")
                )
                
                $installed = $false
                
                foreach ($params in $silentParams) {
                    Write-Output "PROGRESS: $(@{ Message = 'Attempting installation...'; Percent = 80 } | ConvertTo-Json -Compress)"
                    
                    if (-not (Test-Path $installerPath)) {
                        throw "Installer file was removed during installation attempts"
                    }

                    $argString = $params -join " "
                    Write-Output "Attempting installation with: $argString"
                    
                    try {
                        $process = Start-Process -FilePath $installerPath -ArgumentList $params -Wait -PassThru -WindowStyle Hidden
                        if ($process.ExitCode -eq 0) {
                            $installed = $true
                            Write-Output "INSTALLATION_SUCCESS"
                            Write-Output "PROGRESS: $(@{ Message = 'Installation successful'; Percent = 90 } | ConvertTo-Json -Compress)"
                            break
                        }
                    }
                    catch {
                        Write-Output "Installation attempt error: $_"
                        continue
                    }
                }

                if ($installed) {
                    Write-Output "PROGRESS: $(@{ Message = 'Scheduling restart...'; Percent = 95 } | ConvertTo-Json -Compress)"
                    shutdown /r /t 60 /c "System restart required for software installation" /f
                    
                    Write-Output "PROGRESS: $(@{ Message = 'Installation complete'; Percent = 100 } | ConvertTo-Json -Compress)"
                    return @{
                        Success = $true
                        Message = "Installation completed successfully. System will restart in 1 minute."
                    }
                } else {
                    throw "All installation attempts failed"
                }
            } else {
                throw "Installer file not found after download"
            }
        }
        catch {
            Write-Output "Error in remote operation: $_"
            return @{
                Success = $false
                Message = $_.Exception.Message
            }
        }
        finally {
            if (Test-Path $tempDir) {
                Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } -ArgumentList "${installerUrl}"

    if ($result.Success) {
        Write-Progress-Update "Deployment successful" 100
        Write-Output "DEPLOYMENT_SUCCESS"
        Write-Output $result.Message
        exit 0
    } else {
        throw $result.Message
    }
}
catch {
    Write-Output "ERROR: $_"
    Write-Output $_.ScriptStackTrace
    if ($_.ToString() -like "*INSTALLATION_SUCCESS*" -or 
        $_.ToString() -like "*DEPLOYMENT_SUCCESS*") {
        exit 0
    }
    exit 1
}
finally {
    if ($session) {
        Remove-PSSession $session -ErrorAction SilentlyContinue
    }
}`;
}

app.post('/api/deploy', async (req, res) => {
    const { computers, installerUrl } = req.body;
    
    if (!computers || !Array.isArray(computers) || computers.length === 0) {
        return res.status(400).json({ error: 'Invalid computer list' });
    }

    const deploymentId = Date.now().toString();
    const deploymentStatus = {
        id: deploymentId,
        startTime: new Date(),
        computers: computers.map((computer) => ({
            name: computer,
            status: 'pending',
            downloadProgress: 0,
            progress: 0,
            robotStatus: 'pending',
            startTime: new Date(),
            endTime: null,
            details: null,
            currentVersion: null,
            installDate: null,
            publisher: null
        }))
    };

    deployments.set(deploymentId, deploymentStatus);

    console.log('Starting connection checks...');
    const connectionChecks = await Promise.all(
        computers.map(async (computer) => {
            const computerStatus = deploymentStatus.computers.find((c) => c.name === computer);
            computerStatus.details = 'Checking connection...';
            computerStatus.progress = 5;
            console.log(`Checking ${computer}...`);
            
            const isReachable = await checkComputerConnection(computer);
            if (!isReachable) {
                computerStatus.status = 'failed';
                computerStatus.details = 'Computer is not reachable';
                computerStatus.progress = 0;
                computerStatus.endTime = new Date();
                console.log(`${computer} is not reachable`);
            } else {
                computerStatus.progress = 10;
                console.log(`${computer} is reachable`);
            }
            return { computer, isReachable };
        })
    );

    const reachableComputers = connectionChecks
        .filter((check) => check.isReachable)
        .map((check) => check.computer);

    console.log(`Reachable computers: ${reachableComputers.join(', ')}`);

    if (reachableComputers.length === 0) {
        console.log('No reachable computers found');
        return res.json({ deploymentId });
    }

    console.log('Starting deployments...');
    reachableComputers.forEach((computer) => {
        const computerStatus = deploymentStatus.computers.find((c) => c.name === computer);
        computerStatus.status = 'deploying';
        computerStatus.details = 'Starting deployment...';
        computerStatus.progress = 15;

        console.log(`Deploying to ${computer}...`);

        const scriptPath = path.join(os.tmpdir(), `deploy_${computer}_${Date.now()}.ps1`);
        const deployScript = createDeployScript(computer, installerUrl);
        fs.writeFileSync(scriptPath, deployScript);

        const childProcess = exec(
            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
            { maxBuffer: 10 * 1024 * 1024, timeout: 1800000 },
            (error, stdout, stderr) => {
                const status = deploymentStatus.computers.find((c) => c.name === computer);
                status.endTime = new Date();

                console.log(`Deployment completed for ${computer}`);
                console.log('stdout:', stdout);
                
                // Cleanup temp file
                try {
                    fs.unlinkSync(scriptPath);
                } catch (cleanupError) {
                    console.error('Cleanup error:', cleanupError);
                }

                if (stdout && (
                    stdout.includes("INSTALLATION_SUCCESS") || 
                    stdout.includes("DEPLOYMENT_SUCCESS") ||
                    stdout.includes("Installation completed successfully")
                )) {
                    status.status = 'success';
                    status.progress = 100;
                    status.details = 'Installation completed successfully. System will restart in 1 minute.';
                    status.robotStatus = 'running';
                    console.log(`Deployment successful for ${computer}`);
                } else if (error) {
                    if (error.killed && error.signal === 'SIGTERM') {
                        if (stdout && stdout.includes("Installation succeeded")) {
                            status.status = 'success';
                            status.progress = 100;
                            status.details = 'Installation completed successfully. System will restart in 1 minute.';
                            status.robotStatus = 'running';
                            console.log(`Deployment successful for ${computer} (despite termination)`);
                        } else {
                            status.status = 'failed';
                            status.progress = 0;
                            status.details = 'Deployment timed out or was terminated';
                            status.robotStatus = 'failed';
                            console.log(`Deployment timed out for ${computer}`);
                        }
                    } else {
                        status.status = 'failed';
                        status.progress = 0;
                        status.details = `${stdout}\n${stderr || error?.message}`.trim();
                        status.robotStatus = 'failed';
                        console.log(`Deployment failed for ${computer}:`, error);
                    }
                }
            }
        );

        // Handle progress updates from PowerShell
        childProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.includes('PROGRESS:')) {
                    try {
                        const progressJson = line.split('PROGRESS:')[1].trim();
                        const progressData = JSON.parse(progressJson);
                        const status = deploymentStatus.computers.find((c) => c.name === computer);
                        if (status) {
                            status.progress = progressData.Percent;
                            status.details = progressData.Message;
                            console.log(`Progress for ${computer}: ${status.progress}%`);
                        }
                    } catch (e) {
                        console.error('Error parsing progress update:', e);
                    }
                }
            }
        });

        childProcess.on('exit', (code, signal) => {
            console.log(`Process for ${computer} exited with code ${code} and signal ${signal}`);
        });
    });

    res.json({ deploymentId });
});

app.get('/api/deployment/:id', (req, res) => {
    const deployment = deployments.get(req.params.id);
    if (!deployment) {
        return res.status(404).json({ error: 'Deployment not found' });
    }
    res.json(deployment);
});

app.get('/test', (req, res) => {
    res.json({ message: 'Server is running correctly' });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
