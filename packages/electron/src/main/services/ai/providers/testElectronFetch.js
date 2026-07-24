const https = require('https');

async function testWithNodeFetch() {
  console.log('\n=== Testing with Node.js https module directly ===');
  
  const data = JSON.stringify({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' }
    ],
    max_completion_tokens: 10,
    stream: true
  });

  const options = {
    hostname: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Length': data.length
    }
  };

  const startTime = Date.now();
  console.log('Starting request...');

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log(`Response received after ${Date.now() - startTime}ms`);
      console.log(`Status: ${res.statusCode}`);
      
      let firstChunk = false;
      res.on('data', (chunk) => {
        if (!firstChunk) {
          console.log(`First data chunk after ${Date.now() - startTime}ms`);
          firstChunk = true;
        }
      });
      
      res.on('end', () => {
        console.log(`Total time: ${Date.now() - startTime}ms`);
        resolve();
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

if (require.main === module) {
  testWithNodeFetch().catch(console.error);
}

module.exports = { testWithNodeFetch };