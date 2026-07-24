// Quick test script to measure OpenAI API latency
const https = require('https');

async function testOpenAILatency(apiKey) {
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      max_tokens: 10
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': data.length
      }
    };

    console.log(`[${Date.now() - startTime}ms] Starting request...`);

    const req = https.request(options, (res) => {
      console.log(`[${Date.now() - startTime}ms] Got response, status: ${res.statusCode}`);
      
      let firstChunk = false;
      
      res.on('data', (chunk) => {
        if (!firstChunk) {
          console.log(`[${Date.now() - startTime}ms] First chunk received`);
          firstChunk = true;
        }
      });

      res.on('end', () => {
        console.log(`[${Date.now() - startTime}ms] Response complete`);
        resolve(Date.now() - startTime);
      });
    });

    req.on('error', (error) => {
      console.error(`[${Date.now() - startTime}ms] Error:`, error.message);
      reject(error);
    });

    req.write(data);
    req.end();
    console.log(`[${Date.now() - startTime}ms] Request sent`);
  });
}

// Get API key from environment or command line
const apiKey = process.env.OPENAI_API_KEY || process.argv[2];

if (!apiKey) {
  console.error('Please provide OpenAI API key as argument or set OPENAI_API_KEY environment variable');
  process.exit(1);
}

console.log('Testing OpenAI API latency...');
testOpenAILatency(apiKey)
  .then(totalTime => {
    console.log(`\nTotal time: ${totalTime}ms`);
  })
  .catch(error => {
    console.error('Test failed:', error);
  });