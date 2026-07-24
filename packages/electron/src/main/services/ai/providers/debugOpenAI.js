// Debug script to test OpenAI streaming directly
const OpenAI = require('openai');

async function testStreaming(apiKey) {
  console.log('=== OpenAI Streaming Debug Test ===');
  console.log(`Start time: ${new Date().toISOString()}`);
  
  const client = new OpenAI({
    apiKey: apiKey,
    timeout: 90000,
    maxRetries: 2,
  });

  const startTime = Date.now();
  console.log(`[${Date.now() - startTime}ms] Creating completion stream...`);

  try {
    const stream = await client.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      max_completion_tokens: 10,
    });

    console.log(`[${Date.now() - startTime}ms] Stream created, starting iteration...`);

    let chunkCount = 0;
    let firstChunkTime = null;

    for await (const chunk of stream) {
      chunkCount++;
      
      if (!firstChunkTime) {
        firstChunkTime = Date.now() - startTime;
        console.log(`[${firstChunkTime}ms] FIRST CHUNK RECEIVED!`);
        console.log('First chunk data:', JSON.stringify(chunk.choices[0]?.delta, null, 2));
      }
      
      if (chunk.choices[0]?.delta?.content) {
        console.log(`[${Date.now() - startTime}ms] Content: "${chunk.choices[0].delta.content}"`);
      }
    }

    console.log(`[${Date.now() - startTime}ms] Stream complete. Total chunks: ${chunkCount}`);
  } catch (error) {
    console.error(`[${Date.now() - startTime}ms] ERROR:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the test
const apiKey = process.env.OPENAI_API_KEY || process.argv[2];
if (!apiKey) {
  console.error('Please provide OPENAI_API_KEY');
  process.exit(1);
}

testStreaming(apiKey);
