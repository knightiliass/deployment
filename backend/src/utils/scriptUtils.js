// backend/src/utils/scriptUtils.js
function generatePowershellScript(computer, installerPath) {
    return `
$ErrorActionPreference = "Stop"
$computer = "${computer}"
$installerPath = "${installerPath}"

try {
    Write-Output "Testing connection to $computer..."
    if (-not (Test-Connection -ComputerName $computer -Count 1 -Quiet)) {
        throw "Cannot connect to $computer"
    }

    Write-Output "Starting installation on $computer..."
    $result = Invoke-Command -ComputerName $computer -ScriptBlock {
        param($installer)
        try {
            Start-Process -FilePath $installer -ArgumentList "/S" -Wait -NoNewWindow
            return @{
                Success = $true
                Message = "Installation completed successfully"
            }
        } catch {
            return @{
                Success = $false
                Message = $_.Exception.Message
            }
        }
    } -ArgumentList $installerPath

    if ($result.Success) {
        Write-Output "SUCCESS: $($result.Message)"
        exit 0
    } else {
        throw $result.Message
    }
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
    exit 1
}
`;
}

module.exports = {
    generatePowershellScript
};