const express = require('express');
const path = require('path');
const log = require('pino')();
const pinoMiddleware = require('express-pino-logger')({ logger: log });

const { loadConnectedPhoneNumbers } = require('./api/twilio');
const { loadConfig, updateConfigEntry } = require('./data/config');

const PORT = process.env.PORT || 3000;
const CLIENT_CODE_PATH = path.resolve(__dirname, '..', 'client-dist');

(async function() {
  const app = express();

  app.use(pinoMiddleware);
  app.use(express.static(CLIENT_CODE_PATH));

  app.use('/api', require('./api'));

  app.get('*', (req, res, next) => {
    res.sendFile(path.join(CLIENT_CODE_PATH, 'index.html'));
  });

  try {
    await loadConfig();
    const connectedPhoneNumbers = await loadConnectedPhoneNumbers();
    await updateConfigEntry('connectedPhoneNumbers', connectedPhoneNumbers);
    app.listen(PORT, () => {
      log.info(`Server is listening on port ${PORT}`);
    });
  } catch (err) {
    log.error(err);
  }
})();
