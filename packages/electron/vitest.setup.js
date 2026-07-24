import * as dotenv from 'dotenv';
import * as path from 'path';
// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });
// Mock electron for tests that import it
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => '/mock/path'),
        getName: vi.fn(() => 'test-app'),
        getVersion: vi.fn(() => '1.0.0')
    },
    ipcRenderer: {
        send: vi.fn(),
        on: vi.fn(),
        invoke: vi.fn()
    },
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn()
    }
}));
// Set test timeout
beforeAll(() => {
    vi.setConfig({ testTimeout: 10000 });
});
