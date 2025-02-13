const { parentPort, workerData } = require('worker_threads');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function createDeployScript(computer, installerUrl, username, password) {
    return `
$ErrorActionPreference = "Stop"
$VerbosePreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Write-Status($Message) {
    Write-Output "STATUS: $Message"
}

try {
    $installerUrl = '${installerUrl}'
    Write-Status "Installer URL: $installerUrl"
    
    Write-Status "Setting up credentials..."
    $securePassword = ConvertTo-SecureString '${password}' -AsPlainText -Force
    $credentials = New-Object System.Management.Automation.PSCredential ('${username}', $securePassword)

    Write-Status "Creating remote session..."
    $session = New-PSSession -ComputerName ${computer} -Credential $credentials

    Write-Status "Starting remote installation process..."
    $scriptBlock = {
        param($InstallerUrl)
        
        Write-Output "Remote URL: $InstallerUrl"
        
        try {
            $tempDir = "C:\\Windows\\Temp\\install_$(Get-Random)"
            $installerPath = Join-Path $tempDir "installer.exe"
            
            Write-Output "Creating directory: $tempDir"
            New-Item -Path $tempDir -ItemType Directory -Force | Out-Null
            
            Write-Output "Starting download from: $InstallerUrl"
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            
            $webClient = New-Object System.Net.WebClient
            $webClient.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            Write-Output "Downloading to: $installerPath"
            $webClient.DownloadFile($InstallerUrl, $installerPath)
            
            if (Test-Path $installerPath) {
                Write-Output "Installation file downloaded successfully"
                
                $silentParams = @("/verysilent", "/suppressmsgboxes")
                Write-Output "Installing with parameters: $($silentParams -join ' ')"
                
                $process = Start-Process -FilePath $installerPath -ArgumentList $silentParams -Wait -PassThru
                
                if ($process.ExitCode -eq 0) {
                    Write-Output "Installation successful"
                    Write-Output "Scheduling restart..."
                    shutdown /r /t 60 /c "System restart required after software installation" /f
                    return @{
                        Success = $true
                        Message = "Installation completed. System will restart in 1 minute."
                    }
                } else {
                    throw "Installation failed with exit code: $($process.ExitCode)"
                }
            } else {
                throw "Installer not found after download"
            }
        }
        catch {
            Write-Output "Error during installation: $_"
            throw $_
        }
        finally {
            if (Test-Path $tempDir) {
                Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
                Write-Output "Cleaned up temp directory"
            }
        }
    }

    Write-Status "Executing remote script..."
    $result = Invoke-Command -Session $session -ScriptBlock $scriptBlock -ArgumentList $installerUrl

    if ($result.Success) {
        Write-Status $result.Message
        exit 0
    } else {
        throw $result.Message
    }
}
catch {
    Write-Output "ERROR: $_"
    throw $_
}
finally {
    if ($session) {
        Remove-PSSession $session
        Write-Status "Cleaned up session"
    }
}`;
}

async function deployToComputer() {
    const { computer, installerUrl, username, password } = workerData;
    
    try {
        const scriptPath = path.join(os.tmpdir(), `deploy_${computer}_${Date.now()}.ps1`);
        const deployScript = createDeployScript(computer, installerUrl, username, password);
        fs.writeFileSync(scriptPath, deployScript);

        parentPort.postMessage({ type: 'status', computer, status: 'deploying', message: 'Starting deployment...' });

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
            { maxBuffer: 5 * 1024 * 1024 },
            (error, stdout, stderr) => {
                try {
                    fs.unlinkSync(scriptPath);
                } catch (e) {
                    console.error('Cleanup error:', e);
                }

                if (error || stderr) {
                    parentPort.postMessage({
                        type: 'failed',
                        computer,
                        output: stdout,
                        error: stderr || error?.message
                    });
                } else {
                    parentPort.postMessage({
                        type: 'success',
                        computer,
                        output: stdout
                    });
                }
            }
        );
    } catch (error) {
        parentPort.postMessage({
            type: 'failed',
            computer,
            error: error.message
        });
    }
}

deployToComputer();