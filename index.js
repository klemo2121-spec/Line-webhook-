const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Route for LINE Webhook
app.post('/webhook', (req, res) => {
    console.log('Received event:', JSON.stringify(req.body, null, 2));
    res.status(200).send('OK');
});

// Health check route
app.get('/', (req, res) => {
    res.send('LINE Webhook is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
