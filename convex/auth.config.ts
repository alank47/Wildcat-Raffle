// Which token issuers this backend trusts.
//
// Convex tries each provider and uses the first that successfully validates a
// token, which is what makes the two-provider model work: staff arrive with a
// Microsoft token, students with a Google one, and neither needs to say so.
//
// `domain` must equal the token's `iss` claim.
// `applicationID` must equal its `aud` claim.
//
// Neither value is a secret. Both ship in the page and appear in every token.
// The client SECRET is not used by either flow and must never enter this repo,
// which is public. Setup steps: docs/google-signin-setup.md
//
// Read from environment so the same code runs against dev and prod without
// edits, and so a wrong tenant is a config change rather than a commit.
export default {
  providers: [
    // STAFF. Microsoft Entra ID (O365).
    // The v2.0 issuer is tenant specific, so this is also what stops another
    // organization's Microsoft tenant from being accepted.
    {
      domain: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`,
      applicationID: process.env.ENTRA_CLIENT_ID,
    },

    // STUDENTS. Google, the account they already use on their Chromebooks.
    // Google's issuer is shared by every Google account on earth, so the
    // issuer alone proves nothing about which school someone belongs to.
    // The domain check in identity.ts is what does that, server side.
    {
      domain: "https://accounts.google.com",
      applicationID: process.env.GOOGLE_CLIENT_ID,
    },
  ],
};
