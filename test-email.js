const nodemailer = require('nodemailer').default || require('nodemailer');
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: 'schaudhari@lime-media.com',
    pass: 'reeg amth pmpw lnck'
  }
});
transporter.sendMail({
  from: 'schaudhari@lime-media.com',
  to: 'schaudhari@lime-media.com',
  subject: 'Test Conflict Email',
  text: 'Email notifications are working correctly.'
}).then(() => { console.log('Sent'); process.exit(0); })
  .catch(e => { console.error('Failed:', e.message); process.exit(1); });
