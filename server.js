const express = require('express');
const path = require('path');
const fs = require('fs');
const { connect, StringCodec, credsAuthenticator } = require('nats');
const multer = require('multer');
const WebSocket = require('ws');
const cors = require('cors')

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(cors({
    origin: '*' // Correctly configure the origin
}));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// NATS connection state
let nc = null;
let subscriptions = [];

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Connect to NATS
app.post('/api/nats/connect', upload.single('credsFile'), async (req, res) => {
  try {
    const { serverUrl, subjectFilter,credsFile } = req.body;
    console.log("hiiiiiiiiii");
    
    
    // Disconnect if already connected
    if (nc) {
      await nc.close();
      nc = null;
    }
    
    // Prepare connection options
    const options = {
      servers: serverUrl,
    };
    
    // Add credentials if provided
    console.log(req.file);
   
        
      const credsData = fs.readFileSync(path.resolve("uploads/"+credsFile));
      options.authenticator = credsAuthenticator(credsData);
      
      // Clean up uploaded file
    //   fs.unlinkSync(req.file.path);
    
    
    // Connect to NATS
    console.log("Connecting to NATS with options:", options);
    
    nc = await connect(options);
    
    // Subscribe to subjects if filter provided
    if (subjectFilter) {
      const sub = nc.subscribe(subjectFilter);
      (async () => {
        for await (const msg of sub) {
          // In a real implementation, we'd send this to connected clients via WebSocket
          console.log(`Received message on ${msg.subject}: ${StringCodec().decode(msg.data)}`);
          
          // Broadcast to WebSocket clients
          if (wss) {
            const messageData = {
              type: 'nats_message',
              subject: msg.subject,
              data: StringCodec().decode(msg.data),
              timestamp: Date.now()
            };
            
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(messageData));
              }
            });
          }
        }
      })().then();
      
      subscriptions.push(sub);
    }
    
    res.json({ success: true, message: 'Connected to NATS successfully' });
  } catch (error) {
    console.error('NATS connection error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Disconnect from NATS
app.post('/api/nats/disconnect', async (req, res) => {
  try {
    if (nc) {
      // Unsubscribe from all subscriptions
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
      subscriptions = [];
      
      // Close connection
      await nc.close();
      nc = null;
    }
    
    res.json({ success: true, message: 'Disconnected from NATS' });
  } catch (error) {
    console.error('NATS disconnection error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// JetStream - Publish message
app.post('/api/jetstream/publish', async (req, res) => {
  try {
    if (!nc) {
      return res.status(400).json({ success: false, message: 'Not connected to NATS' });
    }
    
    const { subject, message } = req.body;
    const sc = StringCodec();
    
    // For JetStream, we need to get a JetStream client
    const js = nc.jetstream();
    await js.publish(subject, sc.encode(message));
    
    res.json({ success: true, message: 'Message published to JetStream' });
  } catch (error) {
    console.error('JetStream publish error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// JetStream - Get stream info
app.get('/api/jetstream/stream/:stream', async (req, res) => {
  try {
    if (!nc) {
      return res.status(400).json({ success: false, message: 'Not connected to NATS' });
    }
    
    const { stream } = req.params;
    const js = nc.jetstream();
    
    // Get stream information
    const streamInfo = await js.streams.info(stream);
    
    res.json({ success: true, stream: streamInfo });
  } catch (error) {
    console.error('JetStream stream info error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Set up WebSocket server for real-time updates
const server = app.listen(port, () => {
  console.log(`NATS dashboard server running on port ${port}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket');
  
  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  
  if (nc) {
    await nc.close();
  }
  
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});
