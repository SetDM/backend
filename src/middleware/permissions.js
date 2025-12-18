/**
 * Permission middleware for role-based access control
 */

const ROLE_PERMISSIONS = {
    owner: ["view", "edit", "manage_team", "edit_settings"],
    admin: ["view", "edit", "manage_team", "edit_settings"],
    editor: ["view", "edit"],
    viewer: ["view"],
};

/**
 * Get the current user's role
 */
const getUserRole = (req) => {
    // If there's a team member, use their role
    if (req.teamMember) {
        return req.teamMember.role;
    }

    // If there's a user (Instagram owner), they're the owner
    if (req.user) {
        return "owner";
    }

    return null;
};

/**
 * Check if user has a specific permission
 */
const hasPermission = (req, permission) => {
    const role = getUserRole(req);
    if (!role) return false;

    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
};

/**
 * Middleware to require specific permission(s)
 * Usage: requirePermission("edit") or requirePermission(["edit", "manage_team"])
 */
const requirePermission = (permission) => {
    return (req, res, next) => {
        const permissions = Array.isArray(permission) ? permission : [permission];

        if (!req.user) {
            return res.status(401).json({ message: "Authentication required" });
        }

        // Check if user has any of the required permissions
        const hasAny = permissions.some((p) => hasPermission(req, p));

        if (!hasAny) {
            const role = getUserRole(req);
            return res.status(403).json({
                message: "You don't have permission to perform this action",
                requiredPermission: permissions,
                yourRole: role,
            });
        }

        return next();
    };
};

/**
 * Middleware to require all specified permissions
 */
const requireAllPermissions = (permissions) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const hasAll = permissions.every((p) => hasPermission(req, p));

        if (!hasAll) {
            const role = getUserRole(req);
            return res.status(403).json({
                message: "You don't have permission to perform this action",
                requiredPermissions: permissions,
                yourRole: role,
            });
        }

        return next();
    };
};

/**
 * Middleware to require edit permission
 */
const requireEditPermission = requirePermission("edit");

/**
 * Middleware to require team management permission
 */
const requireManageTeamPermission = requirePermission("manage_team");

/**
 * Middleware to require settings edit permission
 */
const requireSettingsPermission = requirePermission("edit_settings");

module.exports = {
    getUserRole,
    hasPermission,
    requirePermission,
    requireAllPermissions,
    requireEditPermission,
    requireManageTeamPermission,
    requireSettingsPermission,
};
