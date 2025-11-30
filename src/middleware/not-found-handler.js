function notFoundHandler(req, res) {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
}

module.exports = notFoundHandler;
