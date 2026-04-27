import { defineAuth } from "@aws-amplify/backend";
import { postConfirmUser } from "./post-confirmation/resource";

export const auth = defineAuth({
  loginWith: {
    email: {
      // can be used in conjunction with a customized welcome email as well
      verificationEmailStyle: "CODE",
      verificationEmailSubject: "Welcome to Home Hub!",
      verificationEmailBody: (createCode) =>
        `Use this code to confirm your account: ${createCode()}`,
      userInvitation: {
        emailSubject: "Welcome to Home Hub!",
        emailBody: (user, code) =>
          `Welcome! You can login with username ${user()} and temporary password ${code()}`,
      },
    },
  },
  groups: ["admins", "home-users"],
  userAttributes: {
    "custom:full_name": {
      dataType: "String",
      mutable: true,
      minLen: 1,
    },
  },
  triggers: {
    // Fires after a user verifies their email; auto-creates or
    // links the matching homePerson row. See handler.ts.
    postConfirmation: postConfirmUser,
  },
});
