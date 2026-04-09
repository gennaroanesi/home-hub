import React, { FormEvent, useState, useEffect } from "react";
import { useRouter } from "next/router";
import type { GetStaticProps } from "next";
import { serverSideTranslations } from "next-i18next/serverSideTranslations";
import { useTranslation, Trans } from "next-i18next";

import {
  signIn,
  signUp,
  confirmSignUp,
  confirmSignIn,
  getCurrentUser,
  resetPassword,
  confirmResetPassword,
  resendSignUpCode,
} from "aws-amplify/auth";

import { Tabs, Tab } from "@heroui/tabs";
import { Card, CardBody } from "@heroui/card";
import { Input } from "@heroui/input";
import { InputOtp } from "@heroui/input-otp";
import { Button } from "@heroui/button";
import { Link } from "@heroui/link";
import { Form } from "@heroui/form";
import { Progress } from "@heroui/progress";
import { addToast } from "@heroui/react";

import { FaEye, FaEyeSlash } from "react-icons/fa";

import DefaultLayout from "@/layouts/default";

type View =
  | "login"
  | "sign-up"
  | "sign-up-otp"
  | "forgot-password"
  | "forgot-password-otp"
  | "force-new-password";

export default function Login() {
  const router = useRouter();
  const { t } = useTranslation("common");

  const [view, setView] = useState<View>("login");
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [otp, setOtp] = useState("");

  useEffect(() => {
    checkLoggedIn();
  }, []);

  useEffect(() => {
    if (otp.length === 6) {
      if (view === "sign-up-otp") {
        handleConfirmSignUp(username, otp);
      }
    }
  }, [otp]);

  async function checkLoggedIn() {
    try {
      const { userId } = await getCurrentUser();
      if (userId) {
        router.push("/admin");
      }
    } catch {
      // not logged in
    }
  }

  function showError(title: string, e: unknown) {
    addToast({
      title,
      description: e instanceof Error ? e.message : String(e),
    });
  }

  // ── Sign In ────────────────────────────────────────────────────────────────

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));

    try {
      setIsLoading(true);
      const { nextStep } = await signIn({
        username: data.email.toString(),
        password: data.password.toString(),
      });

      switch (nextStep.signInStep) {
        case "DONE":
          router.push("/admin");
          break;
        case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED":
          setView("force-new-password");
          break;
        case "CONFIRM_SIGN_UP":
          setView("sign-up-otp");
          break;
        default:
          showError("Sign in", `Unexpected step: ${nextStep.signInStep}`);
      }
    } catch (e) {
      showError("Sign in error", e);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Force New Password (Cognito invited users) ─────────────────────────────

  async function handleForceNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setIsLoading(true);
      const { nextStep } = await confirmSignIn({
        challengeResponse: newPassword,
      });

      if (nextStep.signInStep === "DONE") {
        router.push("/admin");
      } else {
        showError("Sign in", `Unexpected step: ${nextStep.signInStep}`);
      }
    } catch (e) {
      showError("Password error", e);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Sign Up ────────────────────────────────────────────────────────────────

  async function handleSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));

    try {
      setIsLoading(true);
      await signUp({
        username: data.email.toString(),
        password: data.password.toString(),
        options: {
          userAttributes: {
            "custom:full_name": name,
          },
        },
      });
      setView("sign-up-otp");
    } catch (e) {
      showError("Sign up error", e);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirmSignUp(email: string, code: string) {
    try {
      setIsLoading(true);
      await confirmSignUp({ username: email, confirmationCode: code });
      addToast({
        title: t("login.account_confirmed"),
        description: t("login.account_confirmed_description"),
      });
      setOtp("");
      setView("login");
    } catch (e) {
      showError("Confirmation error", e);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleResendSignUpOtp() {
    try {
      setIsLoading(true);
      await resendSignUpCode({ username });
      addToast({
        title: t("login.code_resent"),
        description: t("login.code_resent_description"),
      });
    } catch (e) {
      showError("Resend error", e);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Forgot Password ───────────────────────────────────────────────────────

  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setIsLoading(true);
      await resetPassword({ username });
      setView("forgot-password-otp");
    } catch (e) {
      showError("Reset error", e);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirmResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (otp.length !== 6) {
      showError("Validation", t("login.code_description"));
      return;
    }

    try {
      setIsLoading(true);
      await confirmResetPassword({
        username,
        confirmationCode: otp,
        newPassword,
      });
      addToast({
        title: t("login.password_reset_success"),
        description: t("login.password_reset_success_description"),
      });
      setOtp("");
      setNewPassword("");
      setView("login");
    } catch (e) {
      showError("Reset error", e);
    } finally {
      setIsLoading(false);
    }
  }

  // ── Shared UI pieces ──────────────────────────────────────────────────────

  const passwordToggle = (
    <button
      aria-label="toggle password visibility"
      className="focus:outline-solid outline-transparent"
      type="button"
      onClick={() => setIsPasswordVisible(!isPasswordVisible)}
    >
      {isPasswordVisible ? (
        <FaEyeSlash className="text-xl text-default-400 pointer-events-none" />
      ) : (
        <FaEye className="text-xl text-default-400 pointer-events-none" />
      )}
    </button>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  function renderView() {
    // Forgot password — enter email
    if (view === "forgot-password") {
      return (
        <Form className="flex flex-col gap-4" onSubmit={handleForgotPassword}>
          <p className="text-sm text-default-500">
            {t("login.forgot_password_description")}
          </p>
          <Input
            isRequired
            label={t("login.email_label")}
            placeholder={t("login.email_placeholder")}
            type="email"
            value={username}
            onValueChange={setUsername}
            radius="none"
          />
          <div className="flex gap-2 justify-end">
            <Button
              fullWidth
              color="primary"
              type="submit"
              radius="none"
              isDisabled={isLoading}
            >
              {t("login.send_reset_code")}
            </Button>
          </div>
          <p className="text-center text-small">
            <Link
              className="cursor-pointer"
              size="sm"
              onPress={() => setView("login")}
            >
              {t("login.back_to_login")}
            </Link>
          </p>
        </Form>
      );
    }

    // Forgot password — enter code + new password
    if (view === "forgot-password-otp") {
      return (
        <Form className="flex flex-col gap-4" onSubmit={handleConfirmResetPassword}>
          <p
            className="text-sm text-default-500"
            dangerouslySetInnerHTML={{
              __html: t("login.enter_code_description", { email: username }),
            }}
          />
          <InputOtp
            length={6}
            value={otp}
            onValueChange={setOtp}
            description={t("login.code_description")}
          />
          <Input
            isRequired
            label={t("login.new_password_label")}
            placeholder={t("login.new_password_placeholder")}
            type={isPasswordVisible ? "text" : "password"}
            value={newPassword}
            onValueChange={setNewPassword}
            radius="none"
            endContent={passwordToggle}
          />
          <div className="flex gap-2 justify-end">
            <Button
              fullWidth
              color="primary"
              type="submit"
              radius="none"
              isDisabled={isLoading || otp.length !== 6 || !newPassword}
            >
              {t("login.reset_password")}
            </Button>
          </div>
          <p className="text-center text-small">
            <Link
              className="cursor-pointer"
              size="sm"
              onPress={() => setView("login")}
            >
              {t("login.back_to_login")}
            </Link>
          </p>
        </Form>
      );
    }

    // Force new password (Cognito invited users)
    if (view === "force-new-password") {
      return (
        <Form className="flex flex-col gap-4" onSubmit={handleForceNewPassword}>
          <p className="text-sm text-default-500">
            {t("login.force_new_password_description")}
          </p>
          <Input
            isRequired
            label={t("login.new_password_label")}
            placeholder={t("login.choose_new_password_placeholder")}
            type={isPasswordVisible ? "text" : "password"}
            value={newPassword}
            onValueChange={setNewPassword}
            radius="none"
            endContent={passwordToggle}
          />
          <div className="flex gap-2 justify-end">
            <Button
              fullWidth
              color="primary"
              type="submit"
              radius="none"
              isDisabled={isLoading || !newPassword}
            >
              {t("login.set_password")}
            </Button>
          </div>
        </Form>
      );
    }

    // Sign-up OTP confirmation
    if (view === "sign-up-otp") {
      return (
        <div className="flex flex-col gap-4 py-4">
          <p
            className="text-sm text-default-500"
            dangerouslySetInnerHTML={{
              __html: t("login.signup_otp_description", { email: username }),
            }}
          />
          <InputOtp
            length={6}
            value={otp}
            onValueChange={setOtp}
            description={t("login.verification_code_description")}
          />
          <Button
            color="primary"
            size="sm"
            variant="light"
            onPress={handleResendSignUpOtp}
            isDisabled={isLoading}
          >
            {t("login.resend_code")}
          </Button>
          <p className="text-center text-small">
            <Link
              className="cursor-pointer"
              size="sm"
              onPress={() => setView("login")}
            >
              {t("login.back_to_login")}
            </Link>
          </p>
        </div>
      );
    }

    // Login / Sign-up tabs
    return (
      <Tabs
        fullWidth
        aria-label="Tabs form"
        selectedKey={view === "sign-up" ? "sign-up" : "login"}
        size="md"
        radius="none"
        onSelectionChange={(key) => {
          setView(key.toString() as View);
          setIsLoading(false);
        }}
      >
        <Tab key="login" title={t("login.login")}>
          <Form className="flex flex-col gap-4" onSubmit={handleSignIn}>
            <Input
              isRequired
              name="email"
              label={t("login.email_label")}
              placeholder={t("login.email_placeholder")}
              type="email"
              value={username}
              onValueChange={setUsername}
              radius="none"
            />
            <Input
              isRequired
              name="password"
              label={t("login.password_label")}
              placeholder={t("login.password_placeholder")}
              value={password}
              onValueChange={setPassword}
              radius="none"
              type={isPasswordVisible ? "text" : "password"}
              endContent={passwordToggle}
            />
            <div className="flex justify-between items-center w-full">
              <Link
                className="cursor-pointer"
                size="sm"
                onPress={() => setView("forgot-password")}
              >
                {t("login.forgot_password")}
              </Link>
              <p className="text-small">
                {t("login.need_account")}{" "}
                <Link
                  className="cursor-pointer"
                  size="sm"
                  onPress={() => setView("sign-up")}
                >
                  {t("login.sign_up")}
                </Link>
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                fullWidth
                color="primary"
                type="submit"
                radius="none"
                isDisabled={isLoading}
              >
                {t("login.login")}
              </Button>
            </div>
          </Form>
        </Tab>
        <Tab key="sign-up" title={t("login.sign_up")}>
          <Form className="flex flex-col gap-4" onSubmit={handleSignUp}>
            <Input
              isRequired
              name="name"
              label={t("login.name_label")}
              placeholder={t("login.name_placeholder")}
              type="text"
              value={name}
              onValueChange={setName}
              radius="none"
            />
            <Input
              isRequired
              name="email"
              label={t("login.email_label")}
              placeholder={t("login.email_placeholder")}
              type="email"
              value={username}
              onValueChange={setUsername}
              radius="none"
            />
            <Input
              isRequired
              name="password"
              label={t("login.password_label")}
              placeholder={t("login.password_placeholder")}
              type={isPasswordVisible ? "text" : "password"}
              radius="none"
              endContent={passwordToggle}
            />
            <p className="text-center text-small">
              {t("login.have_account")}{" "}
              <Link
                className="cursor-pointer"
                size="sm"
                onPress={() => setView("login")}
              >
                {t("login.login")}
              </Link>
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                fullWidth
                color="primary"
                type="submit"
                radius="none"
                isDisabled={isLoading}
              >
                {t("login.sign_up")}
              </Button>
            </div>
          </Form>
        </Tab>
      </Tabs>
    );
  }

  return (
    <DefaultLayout>
      <div className="flex justify-center">
        <div className="w-full py-16 px-8 lg:w-1/4">
          <Card className="max-w-full" radius="none">
            {isLoading && (
              <Progress
                isIndeterminate
                aria-label="Loading..."
                className="max-w-md"
                size="sm"
              />
            )}
            <CardBody className="overflow-hidden">
              {renderView()}
            </CardBody>
          </Card>
        </div>
      </div>
    </DefaultLayout>
  );
}

export const getStaticProps: GetStaticProps = async ({ locale }) => ({
  props: {
    ...(await serverSideTranslations(locale ?? "en", ["common"], null, [
      "en",
      "pt-BR",
    ])),
  },
});
