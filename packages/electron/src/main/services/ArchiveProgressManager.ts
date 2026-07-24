import { EventEmitter } from 'events';
import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import * as fs from 'fs';
import * as path from 'path';

const logger = log.scope('ArchiveProgressManager');

export interface ArchiveTask {
  worktreeId: string;
  worktreeName: string;
  status: 'queued' | 'pending' | 'removing-worktree' | 'completed' | 'failed';
  startTime: Date;
  error?: string;
  executeCallback?: () => Promise<void>;
}

/**
 * Persisted task data (without callback)
 */
interface PersistedTask {
  worktreeId: string;
  worktreeName: string;
  status: 'queued' | 'pending' | 'removing-worktree';
  startTime: string; // ISO string for JSON serialization
}

/**
 * Manages a queue of worktree archive tasks, processing them one at a time.
 * This prevents overwhelming git when archiving multiple worktrees at once.
 *
 * Flow:
 * 1. User archives a worktree -> Session archived immediately in DB (fast feedback)
 * 2. Cleanup task queued here -> Worktree removal processed serially
 * 3. Progress emitted to frontend -> UI shows what's happening
 *
 * Queue persistence:
 * - Tasks are persisted to a JSON file when added/completed
 * - On app start, incomplete tasks are loaded for re-processing
 * - This handles cases where the app crashes during archive cleanup
 */
export class ArchiveProgressManager extends EventEmitter {
  private tasks: Map<string, ArchiveTask> = new Map();
  private taskQueue: string[] = [];
  private isProcessing = false;
  private persistFilePath: string | null = null;
  private pendingCallbacksForRestore: Map<string, () => Promise<void>> = new Map();

  /**
   * Get the path to the persist file (lazy initialization)
   */
  private getPersistFilePath(): string {
    if (!this.persistFilePath) {
      const userDataPath = app.getPath('userData');
      this.persistFilePath = path.join(userDataPath, 'archive-queue.json');
    }
    return this.persistFilePath;
  }

  /**
   * Persist the current queue state to disk
   */
  private persistQueue(): void {
    try {
      const filePath = this.getPersistFilePath();

      // Only persist tasks that are not completed/failed
      const tasksToSave: PersistedTask[] = [];
      for (const [id, task] of this.tasks) {
        if (task.status !== 'completed' && task.status !== 'failed') {
          tasksToSave.push({
            worktreeId: task.worktreeId,
            worktreeName: task.worktreeName,
            status: task.status,
            startTime: task.startTime.toISOString(),
          });
        }
      }

      if (tasksToSave.length === 0) {
        // Remove the file if no tasks to persist
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } else {
        fs.writeFileSync(filePath, JSON.stringify(tasksToSave, null, 2));
      }

      logger.info('Persisted archive queue', { taskCount: tasksToSave.length });
    } catch (error) {
      logger.error('Failed to persist archive queue', { error });
    }
  }

  /**
   * Load persisted tasks from disk.
   * Call this at app startup to recover incomplete archive operations.
   *
   * @param createCallback - Factory function to create execution callbacks for recovered tasks
   */
  async loadPersistedTasks(
    createCallback: (worktreeId: string, worktreeName: string) => Promise<(() => Promise<void>) | null>
  ): Promise<{ recovered: number; failed: number }> {
    let recovered = 0;
    let failed = 0;

    try {
      const filePath = this.getPersistFilePath();

      if (!fs.existsSync(filePath)) {
        logger.info('No persisted archive queue found');
        return { recovered, failed };
      }

      const data = fs.readFileSync(filePath, 'utf-8');
      const persistedTasks: PersistedTask[] = JSON.parse(data);

      logger.info('Loading persisted archive tasks', { count: persistedTasks.length });

      for (const persistedTask of persistedTasks) {
        try {
          // Skip if already in the current queue
          if (this.tasks.has(persistedTask.worktreeId)) {
            logger.info('Task already in queue, skipping', { worktreeId: persistedTask.worktreeId });
            continue;
          }

          // Create callback for this task
          const callback = await createCallback(persistedTask.worktreeId, persistedTask.worktreeName);

          if (callback) {
            // Re-add the task to the queue
            const task: ArchiveTask = {
              worktreeId: persistedTask.worktreeId,
              worktreeName: persistedTask.worktreeName,
              status: 'queued',
              startTime: new Date(persistedTask.startTime),
              executeCallback: callback,
            };

            this.tasks.set(persistedTask.worktreeId, task);
            this.taskQueue.push(persistedTask.worktreeId);
            recovered++;

            logger.info('Recovered persisted archive task', {
              worktreeId: persistedTask.worktreeId,
              worktreeName: persistedTask.worktreeName,
            });
          } else {
            failed++;
            logger.warn('Could not create callback for persisted task, skipping', {
              worktreeId: persistedTask.worktreeId,
            });
          }
        } catch (taskError) {
          failed++;
          logger.error('Failed to recover persisted task', {
            worktreeId: persistedTask.worktreeId,
            error: taskError,
          });
        }
      }

      // Clear the persist file since we've loaded the tasks
      // They will be re-persisted as they're processed
      if (recovered > 0) {
        this.emitProgress();
        this.processQueue();
      }

      // Re-persist to update the file (removes failed tasks)
      this.persistQueue();

      logger.info('Finished loading persisted archive tasks', { recovered, failed });
    } catch (error) {
      logger.error('Failed to load persisted archive queue', { error });
    }

    return { recovered, failed };
  }

  /**
   * Add a new archive task to the queue.
   * The task will be processed when it reaches the front of the queue.
   */
  addTask(
    worktreeId: string,
    worktreeName: string,
    executeCallback: () => Promise<void>
  ): void {
    const task: ArchiveTask = {
      worktreeId,
      worktreeName,
      status: 'queued',
      startTime: new Date(),
      executeCallback,
    };

    this.tasks.set(worktreeId, task);
    this.taskQueue.push(worktreeId);

    // Persist queue state
    this.persistQueue();

    this.emitProgress();
    this.processQueue();
  }

  /**
   * Update the status of a task (called by the execute callback to report progress).
   */
  updateTaskStatus(
    worktreeId: string,
    status: ArchiveTask['status'],
    error?: string
  ): void {
    const task = this.tasks.get(worktreeId);
    if (task) {
      task.status = status;
      if (error) {
        task.error = error;
      }
      this.emitProgress();
    }
  }

  /**
   * Get all current tasks (for initial load when component mounts).
   */
  getTasks(): ArchiveTask[] {
    return Array.from(this.tasks.values()).map((task) => ({
      worktreeId: task.worktreeId,
      worktreeName: task.worktreeName,
      status: task.status,
      startTime: task.startTime,
      error: task.error,
    }));
  }

  /**
   * Process the queue one task at a time.
   */
  private async processQueue(): Promise<void> {
    // Only process one at a time
    if (this.isProcessing || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const worktreeId = this.taskQueue.shift()!;
    const task = this.tasks.get(worktreeId);

    if (task?.executeCallback) {
      try {
        task.status = 'pending';
        this.persistQueue(); // Persist status change
        this.emitProgress();

        await task.executeCallback();

        task.status = 'completed';
      } catch (error) {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Archive task failed', { worktreeId, error });
      }

      // Persist after completion/failure (removes from persist file)
      this.persistQueue();
      this.emitProgress();

      // Auto-remove completed/failed tasks after 10 seconds
      // (gives users time to see the completion status, even for long-running tasks)
      setTimeout(() => {
        this.tasks.delete(worktreeId);
        this.emitProgress();
      }, 10000);
    }

    this.isProcessing = false;
    // Process next task in queue
    this.processQueue();
  }

  /**
   * Emit progress to all listeners and broadcast to all renderer windows.
   */
  private emitProgress(): void {
    const tasks = this.getTasks();
    this.emit('archive-progress', tasks);

    // Broadcast to all browser windows
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('archive:progress', tasks);
      }
    }
  }
}

// Singleton instance
export const archiveProgressManager = new ArchiveProgressManager();
