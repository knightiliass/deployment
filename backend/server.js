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
app.use(express.static('public'));

let deployments = new Map();

// Function to check if a computer is reachable
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
        
        exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tempScript}"`,
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

function createDeployScript(computer, installerUrl, username = 'SNILP80', password = 't73fhT3a') {
    return `
$ErrorActionPreference = 'Continue'
$VerbosePreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Write-Status($Message) {
    Write-Output "STATUS: $Message"
}

function Test-WinRMConnection {
    param($ComputerName)
    try {
        Test-WSMan -ComputerName $ComputerName -ErrorAction Stop
        return $true
    } catch {
        Write-Output "WinRM test failed: $_"
        return $false
    }
}

try {
    Write-Status "Testing WinRM connectivity..."
    if (-not (Test-WinRMConnection -ComputerName ${computer})) {
        throw "WinRM is not accessible on ${computer}"
    }

    Write-Status "Setting up credentials..."
    $securePassword = ConvertTo-SecureString '${password}' -AsPlainText -Force
    $credentials = New-Object System.Management.Automation.PSCredential ('${username}', $securePassword)
    
    Write-Status "Testing credential access..."
    $testSession = New-PSSession -ComputerName ${computer} -Credential $credentials -ErrorAction Stop
    if ($testSession) {
        Remove-PSSession $testSession
        Write-Status "Credential test successful"
    }

    Write-Status "Creating remote session..."
    $sessionOptions = New-PSSessionOption -NoMachineProfile -OpenTimeout 60000 -OperationTimeout 1800000
    $session = New-PSSession -ComputerName ${computer} -Credential $credentials -SessionOption $sessionOptions -ErrorAction Stop

    Write-Status "Starting remote installation process..."
    $result = Invoke-Command -Session $session -ScriptBlock {
        param($url)
        $ErrorActionPreference = 'Continue'

        try {
            Write-Output "Setting up temp directory..."
            $tempDir = "C:\\Windows\\Temp\\install_$(Get-Random)"
            $installerPath = Join-Path $tempDir "installer.exe"
            
            if (-not (Test-Path "C:\\Windows\\Temp")) {
                throw "Cannot access Temp directory"
            }
            
            New-Item -Path $tempDir -ItemType Directory -Force | Out-Null
            
            Write-Output "Setting up TLS..."
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            
            Write-Output "Starting download from: $url"
            $webClient = New-Object System.Net.WebClient
            $webClient.Headers.Add("User-Agent", "PowerShell Deployment Script")
            
            try {
                Write-Output "Downloading to: $installerPath"
                $webClient.DownloadFile($url, $installerPath)
                Write-Output "Download completed"
            }
            catch {
                throw "Download failed: $($_.Exception.Message)"
            }

            if (Test-Path $installerPath) {
                Write-Output "Starting installation process..."
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
                            break
                        }
                        Write-Output "Attempt failed with exit code: $($process.ExitCode)"
                    }
                    catch {
                        Write-Output "Installation attempt error: $_"
                        continue
                    }
                }

                if ($installed) {
                    try {
                        Write-Output "Scheduling restart..."
                        $restartJob = Start-Job -ScriptBlock {
                            shutdown.exe /r /t 60 /c "System restart required after software installation" /f
                        }
                        Wait-Job $restartJob -Timeout 10
                        Remove-Job $restartJob -Force
                        
                        return @{
                            Success = $true
                            Message = "Installation completed successfully. System will restart in 1 minute."
                        }
                    }
                    catch {
                        Write-Output "Warning: Restart scheduling had an issue: $_"
                        # Continue as installation was successful
                        return @{
                            Success = $true
                            Message = "Installation completed successfully, but restart scheduling had an issue."
                        }
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
        Write-Status "Cleaning up session..."
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
        computers: computers.map(computer => ({
            name: computer,
            status: 'pending',
            downloadProgress: 0,
            robotStatus: 'pending',
            startTime: new Date(),
            endTime: null,
            details: null
        }))
    };

    deployments.set(deploymentId, deploymentStatus);

    // Check all computers first
    console.log('Starting connection checks...');
    const connectionChecks = await Promise.all(
        computers.map(async computer => {
            const computerStatus = deploymentStatus.computers.find(c => c.name === computer);
            computerStatus.details = 'Checking connection...';
            console.log(`Checking connection for ${computer}...`);
            
            const isReachable = await checkComputerConnection(computer);
            if (!isReachable) {
                computerStatus.status = 'failed';
                computerStatus.details = 'Computer is not reachable';
                computerStatus.endTime = new Date();
                console.log(`${computer} is not reachable`);
            } else {
                console.log(`${computer} is reachable`);
            }
            return { computer, isReachable };
        })
    );

    // Filter out unreachable computers
    const reachableComputers = connectionChecks
        .filter(check => check.isReachable)
        .map(check => check.computer);

    console.log(`Reachable computers: ${reachableComputers.join(', ')}`);

    if (reachableComputers.length === 0) {
        console.log('No reachable computers found');
        return res.json({ deploymentId });
    }

    // Start deployment for each reachable computer
    console.log('Starting deployments...');
    reachableComputers.forEach(computer => {
        const computerStatus = deploymentStatus.computers.find(c => c.name === computer);
        computerStatus.status = 'deploying';
        computerStatus.details = 'Starting deployment...';

        console.log(`Deploying to ${computer}...`);

        const scriptPath = path.join(os.tmpdir(), `deploy_${computer}_${Date.now()}.ps1`);
        const deployScript = createDeployScript(computer, installerUrl);
        fs.writeFileSync(scriptPath, deployScript);

        const childProcess = exec(
            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
            { maxBuffer: 10 * 1024 * 1024, timeout: 1800000 }, // 30 minutes timeout
            (error, stdout, stderr) => {
                const status = deploymentStatus.computers.find(c => c.name === computer);
                status.endTime = new Date();

                console.log(`Deployment completed for ${computer}`);
                console.log('stdout:', stdout);
                
                try {
                    fs.unlinkSync(scriptPath);
                } catch (cleanupError) {
                    console.error('Cleanup error:', cleanupError);
                }

                // Check for success markers in stdout
                if (stdout && (
                    stdout.includes("INSTALLATION_SUCCESS") || 
                    stdout.includes("DEPLOYMENT_SUCCESS") ||
                    stdout.includes("Installation completed successfully")
                )) {
                    status.status = 'success';
                    status.details = 'Installation completed successfully. System will restart in 1 minute.';
                    status.robotStatus = 'running';
                    console.log(`Deployment successful for ${computer}`);
                } else if (error) {
                    if (error.killed && error.signal === 'SIGTERM') {
                        // Check if there was a success message before termination
                        if (stdout && stdout.includes("Installation succeeded")) {
                            status.status = 'success';
                            status.details = 'Installation completed successfully. System will restart in 1 minute.';
                            status.robotStatus = 'running';
                            console.log(`Deployment successful for ${computer} (despite termination)`);
                        } else {
                            status.status = 'failed';
                            status.details = 'Deployment timed out or was terminated';
                            status.robotStatus = 'failed';
                            console.log(`Deployment timed out for ${computer}`);
                        }
                    } else {
                        status.status = 'failed';
                        status.details = `${stdout}\n${stderr || error?.message}`.trim();
                        status.robotStatus = 'failed';
                        console.log(`Deployment failed for ${computer}:`, error);
                    }
                }
            }
        );

        // Handle process cleanup
        childProcess.on('exit', (code, signal) => {
            console.log(`Process exited with code ${code} and signal ${signal}`);
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