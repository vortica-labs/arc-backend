const User = require('../models/User');
const LeaveRequest = require('../models/LeaveRequest');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const log = require('../utils/logger');

// Create leave request
const createLeaveRequest = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { reason } = req.body;
    const staffMemberId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Creating leave request:', { teamId, staffMemberId, reason });
}
    // Verify the team exists
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Check if user is actually a staff member of this team
    const staffMember = team.teamInfo.staff.find(s => 
      s.user.toString() === staffMemberId.toString() && s.isActive
    );

    if (!staffMember) {
      return res.status(404).json({
        success: false,
        message: 'You are not a staff member of this team'
      });
    }

    // Check if there's already a pending leave request
    const existingRequest = await LeaveRequest.findOne({
      team: teamId,
      staffMember: staffMemberId,
      status: 'pending'
    });

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending leave request for this team'
      });
    }

    // Create the leave request
    const leaveRequest = new LeaveRequest({
      team: teamId,
      staffMember: staffMemberId,
      reason: reason || ''
    });

    await leaveRequest.save();

    // Update staff member's leave request status
    staffMember.leaveRequestStatus = 'pending';
    await team.save();

    // Send notification to team owner and other admins
    // Get team owner and other active staff members
    const teamOwnerId = team._id;
    const otherStaffIds = team.teamInfo.staff
      .filter(staff => staff.isActive && staff.user.toString() !== staffMemberId.toString())
      .map(staff => staff.user);

    const recipients = Array.from(new Set([teamOwnerId, ...otherStaffIds].map(String)));
    await Promise.all(recipients.map((recipient) => createAndEmitNotification({
      recipient,
      sender: staffMemberId,
      type: 'system',
      title: 'Staff Leave Request',
      message: `${req.user.profile?.displayName || req.user.username} has requested to leave the team`,
      data: {
        customData: {
          eventType: 'leave_request_created',
          leaveRequestId: leaveRequest._id,
          staffMemberId,
          staffMemberName: req.user.profile?.displayName || req.user.username,
          teamId,
          teamName: team.profile?.displayName || team.username,
          reason: reason || ''
        }
      }
    })));

    res.status(201).json({
      success: true,
      message: 'Leave request submitted successfully',
      data: {
        leaveRequest
      }
    });

  } catch (error) {
    log.error('Error creating leave request:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to create leave request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get leave requests for a team (admin only)
const getTeamLeaveRequests = async (req, res) => {
  try {
    const { teamId } = req.params;
    const adminId = req.user._id;

    // Verify the team exists and user is admin
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Check if user is team owner or active staff member
    const isOwner = team._id.toString() === adminId.toString();
    const isStaff = team.teamInfo.staff.find(s => 
      s.user.toString() === adminId.toString() && s.isActive
    );

    if (!isOwner && !isStaff) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to view leave requests for this team'
      });
    }

    // Get all leave requests for this team
    const leaveRequests = await LeaveRequest.find({ team: teamId })
      .populate('staffMember', 'username profile.displayName profile.avatar')
      .populate('respondedBy', 'username profile.displayName')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        leaveRequests
      }
    });

  } catch (error) {
    log.error('Error fetching leave requests:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave requests',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get user's own leave requests
const getUserLeaveRequests = async (req, res) => {
  try {
    const userId = req.user._id;

    const leaveRequests = await LeaveRequest.find({ staffMember: userId })
      .populate('team', 'username profile.displayName profile.avatar')
      .populate('respondedBy', 'username profile.displayName')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        leaveRequests
      }
    });

  } catch (error) {
    log.error('Error fetching user leave requests:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave requests',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Approve or reject leave request (admin only)
const respondToLeaveRequest = async (req, res) => {
  try {
    const { teamId, requestId } = req.params;
    const { action, adminResponse } = req.body; // action: 'approve' or 'reject'
    const adminId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Responding to leave request:', { teamId, requestId, action, adminResponse });
}
    // Verify the team exists and user is admin
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Check if user is team owner or active staff member
    const isOwner = team._id.toString() === adminId.toString();
    const isStaff = team.teamInfo.staff.find(s => 
      s.user.toString() === adminId.toString() && s.isActive
    );

    if (!isOwner && !isStaff) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to respond to leave requests for this team'
      });
    }

    // Find the leave request - support both player (roster) and staffMember (staff)
    const leaveRequest = await LeaveRequest.findById(requestId)
      .populate('player', 'username profile.displayName')
      .populate('staffMember', 'username profile.displayName');

    if (!leaveRequest || leaveRequest.team.toString() !== teamId) {
      return res.status(404).json({
        success: false,
        message: 'Leave request not found'
      });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Leave request has already been processed'
      });
    }

    // Get the player ID (can be from player field or staffMember field)
    const playerId = leaveRequest.player ? leaveRequest.player._id : 
                     (leaveRequest.staffMember ? leaveRequest.staffMember._id : null);
    
    if (!playerId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid leave request: player or staff member not found'
      });
    }

    // Update leave request status
    leaveRequest.status = action === 'approve' ? 'approved' : 'rejected';
    leaveRequest.adminResponse = adminResponse || '';
    leaveRequest.reviewedAt = new Date();
    leaveRequest.reviewedBy = adminId;

    await leaveRequest.save();

    // Handle roster player leave request
    if (leaveRequest.player && leaveRequest.game && leaveRequest.game !== 'Staff') {
      // Remove player from roster
      const roster = team.teamInfo.rosters.find(r => r.game === leaveRequest.game);
      if (roster) {
        const playerIndex = roster.players.findIndex(p => 
          p.user.toString() === playerId.toString() && p.isActive
        );
        if (playerIndex !== -1) {
          if (action === 'approve') {
            roster.players[playerIndex].isActive = false;
            roster.players[playerIndex].leftAt = new Date();
          }
        }
      }
      
      // Update player's joinedTeams
      const player = await User.findById(playerId);
      if (player && player.userType === 'player') {
        const teamMembership = player.playerInfo.joinedTeams.find(
          teamRef => teamRef.team.toString() === teamId && teamRef.game === leaveRequest.game
        );
        if (teamMembership) {
          if (action === 'approve') {
            teamMembership.isActive = false;
            teamMembership.leftAt = new Date();
          }
          await player.save();
        }
      }
      
      await team.save();
    } 
    // Handle staff member leave request
    else if (leaveRequest.staffMember || (leaveRequest.game && leaveRequest.game === 'Staff')) {
      // Update staff member status in team
      const staffMember = team.teamInfo.staff.find(s => 
        s.user.toString() === playerId.toString()
      );

      if (staffMember) {
        staffMember.leaveRequestStatus = leaveRequest.status;
        
        if (action === 'approve') {
          staffMember.isActive = false;
          staffMember.leftAt = new Date();
        }
        
        await team.save();
      }

      // Update player's joinedTeams status
      const player = await User.findById(playerId);
      if (player && player.userType === 'player') {
        const teamMembership = player.playerInfo.joinedTeams.find(
          teamRef => teamRef.team.toString() === teamId && teamRef.game === 'Staff'
        );
        
        if (teamMembership) {
          if (action === 'approve') {
            teamMembership.isActive = false;
            teamMembership.leftAt = new Date();
          }
          await player.save();
        }
      }
    }

    // Send notification to player/staff member
    await createAndEmitNotification({
      recipient: playerId,
      sender: adminId,
      type: 'system',
      title: `Leave Request ${action === 'approve' ? 'Approved' : 'Rejected'}`,
      message: `Your leave request from ${team.profile?.displayName || team.username} has been ${action === 'approve' ? 'approved' : 'rejected'}`,
      data: {
        customData: {
          eventType: 'leave_request_response',
          leaveRequestId: leaveRequest._id,
          teamId,
          teamName: team.profile?.displayName || team.username,
          status: leaveRequest.status,
          adminResponse: adminResponse || ''
        }
      }
    });

    res.status(200).json({
      success: true,
      message: `Leave request ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
      data: {
        leaveRequest
      }
    });

  } catch (error) {
    log.error('Error responding to leave request:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to respond to leave request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cancel leave request (staff member only)
const cancelLeaveRequest = async (req, res) => {
  try {
    const { teamId, requestId } = req.params;
    const staffMemberId = req.user._id;

    // Find the leave request
    const leaveRequest = await LeaveRequest.findById(requestId);

    if (!leaveRequest || 
        leaveRequest.team.toString() !== teamId || 
        leaveRequest.staffMember.toString() !== staffMemberId.toString()) {
      return res.status(404).json({
        success: false,
        message: 'Leave request not found'
      });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Leave request has already been processed'
      });
    }

    // Delete the leave request
    await LeaveRequest.findByIdAndDelete(requestId);

    // Update staff member status in team
    const team = await User.findById(teamId);
    if (team) {
      const staffMember = team.teamInfo.staff.find(s => 
        s.user.toString() === staffMemberId.toString()
      );
      
      if (staffMember) {
        staffMember.leaveRequestStatus = 'none';
        await team.save();
      }
    }

    res.status(200).json({
      success: true,
      message: 'Leave request cancelled successfully'
    });

  } catch (error) {
    log.error('Error cancelling leave request:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel leave request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  createLeaveRequest,
  getTeamLeaveRequests,
  getUserLeaveRequests,
  respondToLeaveRequest,
  cancelLeaveRequest
};
