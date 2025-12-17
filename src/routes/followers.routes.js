const express = require('express');
const multer = require('multer');
const requirePromptAdmin = require('../middleware/prompt-admin-auth');
const { importFollowersCsv, enrichFollowers } = require('../controllers/followers.controller');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post(
	'/admin/followers/import',
	requirePromptAdmin,
	upload.single('file'),
	importFollowersCsv
);
router.post(
	'/admin/followers/:ownerInstagramId/enrich',
	requirePromptAdmin,
	enrichFollowers
);

module.exports = router;
