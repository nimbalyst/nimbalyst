import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import inspector from 'inspector';

let lastCpuUsage = process.cpuUsage();
let lastTime = Date.now();
let performanceInterval: NodeJS.Timeout | null = null;

// Auto-capture a CPU profile when sustained high CPU is detected. Uses an
// in-process inspector.Session (no port, no SIGUSR1, no DevTools attach
// required) so it works headlessly and never deadlocks the main thread
// waiting for a frontend. Profiles land in the same logs dir as main.log;
// drop the .cpuprofile into Chrome DevTools -> Performance -> Load profile.
const PROFILE_THRESHOLD_PERCENT = 80;
const PROFILE_TRIGGER_SAMPLES = 2; // require N consecutive high samples
const PROFILE_DURATION_MS = 5000;
const PROFILE_COOLDOWN_MS = 60000; // don't re-profile more than once a minute
let highCpuStreak = 0;
let profileInFlight = false;
let lastProfileAt = 0;

async function captureCpuProfile(triggerCpuPercent: number): Promise<void> {
    if (profileInFlight) return;
    const now = Date.now();
    if (now - lastProfileAt < PROFILE_COOLDOWN_MS) return;

    profileInFlight = true;
    lastProfileAt = now;

    const session = new inspector.Session();
    try {
        session.connect();
        const post = <T>(method: string, params?: object) =>
            new Promise<T>((resolve, reject) => {
                session.post(method, params, (err, result) => {
                    if (err) reject(err);
                    else resolve(result as T);
                });
            });

        await post('Profiler.enable');
        await post('Profiler.start');
        await new Promise<void>((r) => setTimeout(r, PROFILE_DURATION_MS));
        const { profile } = await post<{ profile: object }>('Profiler.stop');

        const logsDir = path.join(app.getPath('userData'), 'logs');
        await fs.mkdir(logsDir, { recursive: true });
        const filename = `cpu-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
        const fullPath = path.join(logsDir, filename);
        await fs.writeFile(fullPath, JSON.stringify(profile));

        console.log(`[PERF] Captured CPU profile (trigger=${triggerCpuPercent.toFixed(1)}%) -> ${fullPath}`);
    } catch (err) {
        console.log('[PERF] CPU profile capture failed:', err);
    } finally {
        try { session.disconnect(); } catch { /* already disconnected */ }
        profileInFlight = false;
    }
}

export function startPerformanceMonitoring() {
    performanceInterval = setInterval(() => {
        const currentTime = Date.now();
        const currentCpuUsage = process.cpuUsage();

        const timeDiff = currentTime - lastTime;
        const userDiff = currentCpuUsage.user - lastCpuUsage.user;
        const systemDiff = currentCpuUsage.system - lastCpuUsage.system;

        const cpuPercent = ((userDiff + systemDiff) / (timeDiff * 1000)) * 100;

        if (cpuPercent > 50) {
            console.log('[PERF] High CPU usage:', JSON.stringify({
                cpu: `${cpuPercent.toFixed(1)}%`,
                memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
                handles: (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 'N/A',
                requests: (process as NodeJS.Process & { _getActiveRequests?: () => unknown[] })._getActiveRequests?.()?.length ?? 'N/A'
            }));
        }

        if (cpuPercent > PROFILE_THRESHOLD_PERCENT) {
            highCpuStreak++;
            if (highCpuStreak >= PROFILE_TRIGGER_SAMPLES) {
                highCpuStreak = 0;
                void captureCpuProfile(cpuPercent);
            }
        } else {
            highCpuStreak = 0;
        }

        lastCpuUsage = currentCpuUsage;
        lastTime = currentTime;
    }, 10000); // Check every 10 seconds
}

export function stopPerformanceMonitoring() {
    if (performanceInterval) {
        clearInterval(performanceInterval);
        performanceInterval = null;
    }
}
