function redactEmail(value) {
  if (!value || typeof value !== 'string') return 'unknown';
  const parts = value.split('@');
  if (parts.length !== 2) return redactId(value);
  const [localPart, domain] = parts;
  return `${localPart.slice(0, 1) || '*'}***@${domain.slice(0, 1) || '*'}***`;
}

function redactId(value) {
  if (!value || typeof value !== 'string') return 'unknown';
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...`;
}

function summarizeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  return String(err);
}

module.exports = {
  redactEmail,
  redactId,
  summarizeError,
};