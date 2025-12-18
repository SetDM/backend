const { Resend } = require("resend");
const config = require("../config/environment");
const logger = require("../utils/logger");

let resendClient = null;

const getResendClient = () => {
    if (resendClient) return resendClient;

    if (!config.email?.resendApiKey) {
        logger.warn("Email not configured - RESEND_API_KEY required");
        return null;
    }

    resendClient = new Resend(config.email.resendApiKey);
    return resendClient;
};

const sendEmail = async ({ to, subject, html, text }) => {
    const client = getResendClient();

    if (!client) {
        logger.warn("Email not sent - Resend not configured", { to, subject });
        return { sent: false, reason: "Email not configured" };
    }

    try {
        const { data, error } = await client.emails.send({
            from: config.email.fromAddress || "SetDM <noreply@setdm.ai>",
            to,
            subject,
            html,
            text,
        });

        if (error) {
            logger.error("Failed to send email", { to, subject, error: error.message });
            return { sent: false, reason: error.message };
        }

        logger.info("Email sent successfully", { to, subject, messageId: data?.id });
        return { sent: true, messageId: data?.id };
    } catch (error) {
        logger.error("Failed to send email", { to, subject, error: error.message });
        return { sent: false, reason: error.message };
    }
};

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

const sendTeamInviteEmail = async ({ to, inviterName, workspaceName, role, inviteUrl }) => {
    const subject = `You've been invited to join ${workspaceName || "a workspace"} on SetDM`;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Team Invite</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <tr>
            <td>
                <div style="background: white; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <!-- Logo -->
                    <div style="text-align: center; margin-bottom: 32px;">
                        <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #18181b;">SetDM</h1>
                    </div>
                    
                    <!-- Content -->
                    <h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #18181b;">
                        You've been invited!
                    </h2>
                    
                    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #52525b;">
                        <strong>${inviterName || "Someone"}</strong> has invited you to join 
                        <strong>${workspaceName || "their workspace"}</strong> on SetDM as ${role === "admin" ? "an" : "a"} <strong>${role}</strong>.
                    </p>
                    
                    <p style="margin: 0 0 32px; font-size: 14px; line-height: 1.6; color: #71717a;">
                        SetDM helps automate Instagram DM conversations with AI. As a team member, you'll be able to 
                        ${role === "admin" ? "manage all settings and team members" : role === "editor" ? "manage conversations and AI scripts" : "view conversations and stats"}.
                    </p>
                    
                    <!-- CTA Button -->
                    <div style="text-align: center; margin-bottom: 32px;">
                        <a href="${inviteUrl}" 
                           style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: white; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;">
                            Accept Invite
                        </a>
                    </div>
                    
                    <!-- Link fallback -->
                    <p style="margin: 0 0 8px; font-size: 12px; color: #a1a1aa; text-align: center;">
                        Or copy and paste this link:
                    </p>
                    <p style="margin: 0 0 32px; font-size: 12px; color: #71717a; text-align: center; word-break: break-all;">
                        ${inviteUrl}
                    </p>
                    
                    <!-- Expiry notice -->
                    <div style="background: #fef3c7; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px;">
                        <p style="margin: 0; font-size: 13px; color: #92400e;">
                            ⏰ This invite expires in 24 hours.
                        </p>
                    </div>
                    
                    <!-- Footer -->
                    <p style="margin: 0; font-size: 13px; color: #a1a1aa; text-align: center;">
                        If you didn't expect this invite, you can safely ignore this email.
                    </p>
                </div>
                
                <!-- Email footer -->
                <p style="margin: 24px 0 0; font-size: 12px; color: #a1a1aa; text-align: center;">
                    © ${new Date().getFullYear()} SetDM. All rights reserved.
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();

    const text = `
You've been invited to join ${workspaceName || "a workspace"} on SetDM!

${inviterName || "Someone"} has invited you as ${role === "admin" ? "an" : "a"} ${role}.

Accept the invite here: ${inviteUrl}

This invite expires in 24 hours.

If you didn't expect this invite, you can safely ignore this email.
    `.trim();

    return sendEmail({ to, subject, html, text });
};

const sendMagicLinkEmail = async ({ to, name, loginUrl, workspaceName }) => {
    const subject = `Your SetDM login link`;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login Link</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <tr>
            <td>
                <div style="background: white; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <!-- Logo -->
                    <div style="text-align: center; margin-bottom: 32px;">
                        <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #18181b;">SetDM</h1>
                    </div>
                    
                    <!-- Content -->
                    <h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #18181b;">
                        Hi${name ? ` ${name}` : ""}! 👋
                    </h2>
                    
                    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.6; color: #52525b;">
                        Click the button below to log in to ${workspaceName || "your workspace"} on SetDM.
                    </p>
                    
                    <!-- CTA Button -->
                    <div style="text-align: center; margin-bottom: 32px;">
                        <a href="${loginUrl}" 
                           style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: white; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;">
                            Log In to SetDM
                        </a>
                    </div>
                    
                    <!-- Link fallback -->
                    <p style="margin: 0 0 8px; font-size: 12px; color: #a1a1aa; text-align: center;">
                        Or copy and paste this link:
                    </p>
                    <p style="margin: 0 0 32px; font-size: 12px; color: #71717a; text-align: center; word-break: break-all;">
                        ${loginUrl}
                    </p>
                    
                    <!-- Expiry notice -->
                    <div style="background: #fef3c7; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px;">
                        <p style="margin: 0; font-size: 13px; color: #92400e;">
                            ⏰ This link expires in 15 minutes.
                        </p>
                    </div>
                    
                    <!-- Security notice -->
                    <p style="margin: 0; font-size: 13px; color: #a1a1aa; text-align: center;">
                        If you didn't request this login link, you can safely ignore this email.
                    </p>
                </div>
                
                <!-- Email footer -->
                <p style="margin: 24px 0 0; font-size: 12px; color: #a1a1aa; text-align: center;">
                    © ${new Date().getFullYear()} SetDM. All rights reserved.
                </p>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();

    const text = `
Hi${name ? ` ${name}` : ""}!

Click this link to log in to ${workspaceName || "your workspace"} on SetDM:

${loginUrl}

This link expires in 15 minutes.

If you didn't request this login link, you can safely ignore this email.
    `.trim();

    return sendEmail({ to, subject, html, text });
};

module.exports = {
    sendEmail,
    sendTeamInviteEmail,
    sendMagicLinkEmail,
    getResendClient,
};
