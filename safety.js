'use strict';

// Safety helpers.
// High-impact Discord actions (delete messages, manage roles/channels/members,
// broad announcements, costly external API calls) are intentionally NOT
// implemented in this bot. When they are added later, they MUST go through
// requestApproval() here, which requires an explicit owner confirmation in
// Discord before execution.

const config = require('./config');

function isOwner(interaction) {
  const uid = interaction && interaction.user && interaction.user.id;
  return Boolean(uid && config.ownerId && uid === config.ownerId);
}

// Approval gate stub (future use).
// function requestApproval({ action, detail, interaction }) { ... }

module.exports = { isOwner };
