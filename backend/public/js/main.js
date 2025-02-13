let currentDeploymentId = null;

// Start deployment
async function startDeployment() {
    const installerUrl = document.getElementById('installerUrl').value;
    const computers = document.getElementById('computers').value
        .split('\n')
        .map(c => c.trim())
        .filter(Boolean);
    
    if (!installerUrl || computers.length === 0) {
        alert('Please fill in all required fields');
        return;
    }

    document.getElementById('deployBtn').disabled = true;

    try {
        const response = await fetch('/api/deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                computers,
                installerUrl
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        currentDeploymentId = data.deploymentId;
        document.getElementById('currentDeployments').style.display = 'block';
        pollDeploymentStatus();
    } catch (error) {
        alert(`Deployment failed: ${error.message}`);
        document.getElementById('deployBtn').disabled = false;
    }
}

// Poll deployment status
async function pollDeploymentStatus() {
    if (!currentDeploymentId) return;

    try {
        const response = await fetch(`/api/deployment/${currentDeploymentId}`);
        if (!response.ok) {
            throw new Error('Failed to fetch deployment status');
        }

        const deployment = await response.json();
        updateDeploymentStatus(deployment);
        updateStats(deployment);

        const isComplete = deployment.computers.every(c => 
            c.status === 'success' || c.status === 'failed'
        );

        if (!isComplete) {
            setTimeout(pollDeploymentStatus, 1000);
        } else {
            document.getElementById('deployBtn').disabled = false;
            
            const successCount = deployment.computers.filter(c => c.status === 'success').length;
            const failedCount = deployment.computers.filter(c => c.status === 'failed').length;
            
            alert(`Deployment completed!\nSuccessful: ${successCount}\nFailed: ${failedCount}`);
        }
    } catch (error) {
        console.error('Failed to check status:', error);
        setTimeout(pollDeploymentStatus, 1000);
    }
}

// Update deployment status in the UI
function updateDeploymentStatus(deployment) {
    const deploymentsList = document.getElementById('deploymentsList');
    deploymentsList.innerHTML = deployment.computers.map(computer => `
        <div class="border rounded p-4 ${getBackgroundClass(computer.status)}">
            <div class="flex justify-between items-center mb-2">
                <h3 class="font-medium">${computer.name}</h3>
                <span class="px-2 py-1 rounded text-sm ${getStatusClass(computer.status)}">
                    ${computer.status.toUpperCase()}
                </span>
            </div>
            <div class="space-y-2">
                <div class="relative pt-1">
                    <div class="flex mb-2 items-center justify-between">
                        <div>
                            <span class="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full ${getStatusClass(computer.status)}">
                                ${computer.details || 'In Progress...'}
                            </span>
                        </div>
                        <div class="text-right">
                            <span class="text-xs font-semibold inline-block">
                                ${formatDuration(computer.startTime, computer.endTime)}
                            </span>
                        </div>
                    </div>
                    <div class="overflow-hidden h-2 mb-4 text-xs flex rounded bg-gray-200">
                        <div class="progress-bar shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center ${getProgressBarColor(computer.status)}"
                             style="width: ${computer.status === 'pending' ? '0' : computer.status === 'success' ? '100' : '50'}%"></div>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Update stats
function updateStats(deployment) {
    const stats = {
        total: deployment.computers.length,
        success: 0,
        inProgress: 0,
        failed: 0
    };

    deployment.computers.forEach(computer => {
        if (computer.status === 'success') stats.success++;
        else if (computer.status === 'failed') stats.failed++;
        else stats.inProgress++;
    });

    document.getElementById('totalDeployments').textContent = stats.total;
    document.getElementById('successRate').textContent = 
        `${Math.round((stats.success / stats.total) * 100)}%`;
    document.getElementById('inProgress').textContent = stats.inProgress;
    document.getElementById('failed').textContent = stats.failed;
}

// Helper functions for styling
function getBackgroundClass(status) {
    switch (status) {
        case 'success': return 'bg-green-50';
        case 'failed': return 'bg-red-50';
        default: return 'bg-white';
    }
}

function getStatusClass(status) {
    switch (status) {
        case 'success': return 'bg-green-100 text-green-800';
        case 'failed': return 'bg-red-100 text-red-800';
        default: return 'bg-blue-100 text-blue-800';
    }
}

function getProgressBarColor(status) {
    switch (status) {
        case 'success': return 'bg-green-500';
        case 'failed': return 'bg-red-500';
        default: return 'bg-blue-500';
    }
}

// Format duration
function formatDuration(startTime, endTime) {
    if (!startTime || !endTime) return '';
    const duration = new Date(endTime) - new Date(startTime);
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? 
        `${minutes}m ${seconds % 60}s` : 
        `${seconds}s`;
}

// Initialize event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Add form submission handler
    const form = document.querySelector('form');
    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            startDeployment();
        });
    }
});