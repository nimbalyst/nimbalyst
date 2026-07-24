#!/usr/bin/env node

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

// Create a test file
const testFile = path.join(__dirname, 'test-watch-file.md');
fs.writeFileSync(testFile, '# Test\n\nInitial content\n');

console.log('Test file created:', testFile);
console.log('Setting up watcher...');

const watcher = chokidar.watch(testFile, {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 100,
    awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 25
    },
    atomic: true
});

watcher.on('ready', () => {
    console.log('Watcher ready! Now modify the file externally...');
});

watcher.on('change', (filePath) => {
    console.log('*** CHANGE DETECTED ***:', filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    console.log('New content:', content);
});

watcher.on('raw', (event, path, details) => {
    console.log('RAW event:', event, path, details);
});

watcher.on('error', (error) => {
    console.error('Watcher error:', error);
});

// Modify the file after 2 seconds
setTimeout(() => {
    console.log('\n=== Modifying file externally ===');
    fs.writeFileSync(testFile, '# Test\n\nInitial content\n\nModified content!\n');
    console.log('File modified, waiting for detection...');
}, 2000);

// Keep process alive
setTimeout(() => {
    console.log('\n=== Test complete ===');
    watcher.close();
    fs.unlinkSync(testFile);
    process.exit(0);
}, 5000);
