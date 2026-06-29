const mongoose = require('mongoose');

const tournamentHostActiveLockSchema = new mongoose.Schema({
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  tournament: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    required: true,
    index: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('TournamentHostActiveLock', tournamentHostActiveLockSchema);
