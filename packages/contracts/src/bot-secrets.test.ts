import { describe, expect, it } from "vitest";
import {
  BOT_SECRET_ORIGIN_MISSING_MESSAGE,
  BotSecretDestination,
  BotSecretDestinationInput,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  encodeLoginSecret,
  extractOneTimeCode,
  hideOneTimeCodeInEmail,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  loginCardFields,
  normalizeOneTimeCode,
  OneTimeCodeTarget,
  oneTimeCodeWritings,
  SecretHttpRequest,
} from "./bot-secrets.js";
import { AGENT_SECRET_NAME_PATTERN } from "./domain.js";

const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};

describe("credential contracts", () => {
  it.each([
    "http://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?query=1",
    "https://api.example.test#fragment",
  ])("rejects non-origin destination %s", (origin) => {
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each([undefined, ""])(
    "reports a missing origin (%j) as missing, for a login too",
    (origin) => {
      for (const auth of [{ type: "login" }, { type: "bearer" }]) {
        const result = BotSecretDestination.safeParse({ name: "example_login", origin, auth });
        expect(result.success).toBe(false);
        expect(
          result.error?.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        ).toEqual([{ path: ["origin"], message: BOT_SECRET_ORIGIN_MISSING_MESSAGE }]);
      }
    },
  );
  it("keeps the origin rule message for an origin that is present but invalid", () => {
    const result = BotSecretDestination.safeParse({
      name: "example_login",
      origin: "www.example.com",
      auth: { type: "login" },
    });
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([
      "Expected an HTTPS origin without a path, credentials, query, or fragment",
    ]);
  });
  it("accepts a valid login origin, and a command variable without one", () => {
    expect(
      BotSecretDestination.safeParse({
        name: "example_login",
        origin: "https://www.example.com",
        auth: { type: "login" },
      }).success,
    ).toBe(true);
    expect(
      BotSecretDestination.safeParse({ name: "example_cmd", auth: { type: "command" } }).success,
    ).toBe(true);
  });
  it.each(["feishu-app-credentials", "my-creds-2", "team_a-bot"])(
    "accepts hyphenated credential names like %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(true);
    },
  );
  it.each(["Feishu App", "-leading", "with space", ""])(
    "rejects malformed credential names %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(false);
    },
  );
  it.each([
    "Host",
    "Connection",
    "Content-Length",
    "Cookie",
    "Proxy-Authorization",
    "X-Forwarded-Host",
    "Sec-Fetch-Site",
    "X-Key\r\nHost",
  ])("rejects reserved or malformed header %s", (name) => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "header", name } }).success,
    ).toBe(false);
  });
  it.each(["GET", "HEAD"])("rejects even an empty body on %s", (method) => {
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method,
        body: "",
      }).success,
    ).toBe(false);
  });
  it("accepts ordinary authentication and bounds request inputs", () => {
    expect(BotSecretDestination.parse(destination)).toEqual(destination);
    expect(
      BotSecretDestination.safeParse({
        ...destination,
        auth: { type: "header", name: "X-Api-Key" },
      }).success,
    ).toBe(true);
    expect(
      SecretHttpRequest.safeParse({ name: "example_api", url: destination.origin, body: "body" })
        .success,
    ).toBe(false);
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method: "POST",
        body: "x".repeat(100_001),
      }).success,
    ).toBe(false);
  });
});

describe("private HTTP credential origins", () => {
  const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });

  it("rejects private HTTP origins by default", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, origin: "http://192.168.2.10:8080" })
        .success,
    ).toBe(false);
  });
  it.each([
    "http://192.168.2.10:8080",
    "http://10.1.2.3",
    "http://172.16.5.4",
    "http://172.31.255.254",
    "http://100.100.1.5",
    "http://localhost:3000",
    "http://nas.local",
  ])("accepts private HTTP origin %s when the owner opts in", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(true);
  });
  it("still rejects public HTTP origins when the owner opts in", () => {
    expect(relaxed.safeParse({ ...destination, origin: "http://api.example.test" }).success).toBe(
      false,
    );
  });
  it("rejects a private HTTP origin for a website login even when the owner opts in", () => {
    expect(
      relaxed.safeParse({
        ...destination,
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" },
      }).success,
    ).toBe(false);
    expect(relaxed.safeParse({ ...destination, auth: { type: "login" } }).success).toBe(true);
  });
  it.each([
    "http://192.168.2.10:8080/upload",
    "http://192.168.2.10:8080?key=1",
    "http://100.100.100.200",
    "http://169.254.170.2",
    "http://169.254.169.254",
  ])("relaxed schema still rejects non-origin URLs %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each([
    "https://[::ffff:169.254.169.254]",
    "https://[fd00:ec2::254]",
    "https://metadata.goog.",
  ])("rejects a metadata origin in any form %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
});

describe("login credentials", () => {
  const fields = [
    { label: "ID number", value: "fake-id-123", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: true },
    { label: "PIN", value: " 0000 ", hidden: true },
  ];

  it("accepts a login destination and round-trips its fields in order", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "login" } }).success,
    ).toBe(true);
    expect(decodeLoginSecret(encodeLoginSecret({ fields }))).toEqual({ fields });
  });

  it("writes only the fields, so a release without them fails to read a new login", () => {
    const stored = JSON.parse(encodeLoginSecret({ fields }));
    expect(Object.keys(stored)).toEqual(["fields"]);
    expect(stored).not.toHaveProperty("username");
    expect(stored).not.toHaveProperty("password");
  });

  it("reads a saved username and password as a visible Username and a hidden Password", () => {
    const legacy = JSON.stringify({
      username: "fake-user",
      password: "fake:password\nwith newline",
    });
    expect(decodeLoginSecret(legacy)).toEqual({
      fields: [
        { label: "Username", value: "fake-user", hidden: false },
        { label: "Password", value: "fake:password\nwith newline", hidden: true },
      ],
    });
  });

  it("trims visible values and labels but keeps hidden values exactly as typed", () => {
    const { fields: saved } = decodeLoginSecret(
      encodeLoginSecret({
        fields: [
          { label: " Email ", value: " fake@example.test ", hidden: false },
          { label: "Password", value: " fake password ", hidden: true },
        ],
      }),
    );
    expect(saved).toEqual([
      { label: "Email", value: "fake@example.test", hidden: false },
      { label: "Password", value: " fake password ", hidden: true },
    ]);
  });

  it.each([
    ["no fields", { fields: [] }],
    ["an empty value", { fields: [{ label: "Code", value: "", hidden: true }] }],
    ["a blank visible value", { fields: [{ label: "ID", value: "  ", hidden: false }] }],
    ["an empty label", { fields: [{ label: " ", value: "fake", hidden: true }] }],
    ["a long label", { fields: [{ label: "x".repeat(65), value: "fake", hidden: true }] }],
    ["a long value", { fields: [{ label: "Password", value: "x".repeat(4097), hidden: true }] }],
    [
      "too many fields",
      {
        fields: Array.from({ length: LOGIN_FIELD_LIMIT + 1 }, (_, index) => ({
          label: `Field ${index}`,
          value: "fake",
          hidden: true,
        })),
      },
    ],
    [
      "labels that differ only in case",
      {
        fields: [
          { label: "Code", value: "fake-1", hidden: true },
          { label: "code ", value: "fake-2", hidden: true },
        ],
      },
    ],
    ["a field without hidden", { fields: [{ label: "Password", value: "fake" }] }],
  ])("rejects a login with %s", (_, value) => {
    expect(() => encodeLoginSecret(value as never)).toThrow();
    expect(() => decodeLoginSecret(JSON.stringify(value))).toThrow();
  });

  it("rejects a login longer than a credential can be", () => {
    const value = {
      fields: Array.from({ length: 5 }, (_, index) => ({
        label: `Field ${index}`,
        value: "x".repeat(4096),
        hidden: true,
      })),
    };
    expect(() => encodeLoginSecret(value)).toThrow();
  });

  it.each([
    { username: "", password: "fake-password" },
    { username: "fake-user", password: "" },
    { username: "fake-user" },
  ])("rejects an incomplete saved pair %j", (value) => {
    expect(() => decodeLoginSecret(JSON.stringify(value))).toThrow();
  });

  it("starts the default card as logins always have", () => {
    expect(loginCardFields(undefined)).toEqual([
      { label: "Username", value: "", hidden: false },
      { label: "Password", value: "", hidden: true },
    ]);
    // Naming the default labels gives the same card, so the bot gains nothing by it.
    expect(loginCardFields(["Username", "Password"])).toEqual(loginCardFields(undefined));
  });

  it("starts an ID and a phone visible for a sign-in with no password field", () => {
    expect(loginCardFields(["ID number", "Phone number", "SMS code"])).toEqual([
      { label: "ID number", value: "", hidden: false },
      { label: "Phone number", value: "", hidden: false },
      { label: "SMS code", value: "", hidden: true },
    ]);
  });

  it.each([
    "ID",
    "ID number",
    "  id-number ",
    "Email",
    "E-mail address",
    "e/mail",
    "Email or phone",
    "Mobile phone",
    "Account number",
    "Customer ID",
    "National ID",
    "Tax ID",
    "Employee ID",
    "Login name",
    "Last 4 digits of ID",
    "Account #",
    "ID \u2116",
    "Account \u2116",
    "Acc\u200Bount",
    "PHONE",
    "Télephone",
    "ＩＤ ｎｕｍｂｅｒ",
    "תעודת זהות",
    "ת.ז.",
    "הטלפון הנייד",
    "מספר טלפון",
    "מספר חשבון",
    "\u200Fמייל\u200F",
    "שם משתמש",
  ])("starts %j visible", (label) => {
    expect(loginCardFields([label])[0]!.hidden).toBe(false);
  });

  it.each([
    "Password",
    "PIN",
    "Account PIN",
    "Phone password",
    "Email code",
    "Verification code",
    "One-time code (OTP)",
    "ID answer",
    "API key",
    "Token",
    "CVV",
    // Plurals, abbreviations and other spellings of a secret.
    "Account passwords",
    "Account PINs",
    "Account codes",
    "Account pwd",
    "Account passwd",
    "Account pw",
    "Account pincode",
    "Account credentials",
    "Account 2FA",
    "Account TOTP",
    "Account CVV2",
    // Look-alike and invisible letters.
    "Account P\u0430ssword",
    "Account \uFF30\uFF29\uFF2E",
    "Account PIN\u3164",
    "Account\u3164",
    "Account\u{1F511}",
    "Account \u{1F512}",
    "Phone \u2731\u2731\u2731",
    "ID \u{1F511} number",
    "Account +",
    // Labels we don't recognise stay hidden.
    "Memorable word",
    "Mother's maiden name",
    "Card number",
    "Date of birth",
    "Name",
    "Number",
    "Hid",
    "Provider",
    "סיסמה",
    "קוד SMS",
    "הקוד",
    "טלפון סודי",
    "קוד אימות",
    "סיסמת חשבון",
    "ססמת חשבון",
    "חשבון פין",
    "טלפון וסיסמה",
    "חשבון וקוד",
  ])("starts %j hidden", (label) => {
    expect(loginCardFields([label])[0]!.hidden).toBe(true);
  });

  it.each([[["Username", "Password"]], [["ID", "Phone", "Code"]]])(
    "accepts requested labels %j",
    (labels) => {
      expect(LoginFieldLabels.safeParse(labels).success).toBe(true);
    },
  );

  it.each([[[]], [["Code", "CODE"]], [[""]]])("rejects requested labels %j", (labels) => {
    expect(LoginFieldLabels.safeParse(labels).success).toBe(false);
  });
});

describe("command variables", () => {
  const command = { type: "command" } as const;

  it.each([
    ["netbird-setup-key", "NETBIRD_SETUP_KEY"],
    ["github_pat", "GITHUB_PAT"],
    ["a", "A"],
    ["x-1_y-2", "X_1_Y_2"],
  ])("exports %s as $%s, a valid space variable name", (name, variable) => {
    expect(commandVariableName(name)).toBe(variable);
    expect(AGENT_SECRET_NAME_PATTERN.test(variable)).toBe(true);
    expect(commandVariableProblem(variable)).toBeUndefined();
  });

  it.each([
    "PATH",
    "HOME",
    "IFS",
    "ENV",
    "BASH_ENV",
    "PROMPT_COMMAND",
    "PS4",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PYTHONPATH",
    "PERL5OPT",
    "RUBYOPT",
    "JDK_JAVA_OPTIONS",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "SSLKEYLOGFILE",
    "GIT_SSL_CAINFO",
    "GIT_SSL_NO_VERIFY",
    "OPENSSL_CONF",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GCONV_PATH",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_REGISTRY",
    "SSH_ASKPASS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_ANYTHING",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_ANYTHING",
    "RAKAZO_TOKEN",
  ])("reserves $%s", (variable) => {
    expect(commandVariableProblem(variable)).toBe("reserved");
  });

  it("reserves exact names and prefixes only", () => {
    expect(commandVariableProblem("PATHS")).toBeUndefined();
    expect(commandVariableProblem("MY_PATH")).toBeUndefined();
    expect(commandVariableProblem("OLD_LD_FLAG")).toBeUndefined();
  });

  it("marks a name outside the space variable pattern invalid", () => {
    expect(commandVariableProblem("lower")).toBe("invalid");
    expect(commandVariableProblem("1ABC")).toBe("invalid");
    expect(commandVariableProblem("A".repeat(65))).toBe("invalid");
  });

  it("accepts a command destination with a missing or empty origin", () => {
    for (const schema of [
      BotSecretDestination,
      botSecretDestinationSchema({ allowPrivateHttpOrigin: true }),
    ]) {
      expect(schema.parse({ name: "netbird-setup-key", auth: command })).toEqual({
        name: "netbird-setup-key",
        origin: "",
        auth: command,
      });
      expect(
        schema.safeParse({ name: "netbird-setup-key", origin: "", auth: command }).success,
      ).toBe(true);
    }
  });

  it("rejects a site on a command destination", () => {
    const result = BotSecretDestination.safeParse({
      name: "netbird-setup-key",
      origin: "https://api.example.test",
      auth: command,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["origin"]);
  });

  it.each([
    ["ld_preload", "$LD_PRELOAD"],
    ["dyld-insert-libraries", "$DYLD_INSERT_LIBRARIES"],
    ["path", "$PATH"],
    ["rakazo-token", "$RAKAZO_TOKEN"],
  ])("rejects %s because %s is reserved", (name, variable) => {
    const result = BotSecretDestination.safeParse({ name, auth: command });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["name"],
      message: expect.stringContaining(`${variable} is reserved`),
    });
  });

  it("does not reserve names for credentials that are not command variables", () => {
    expect(BotSecretDestination.safeParse({ ...destination, name: "path" }).success).toBe(true);
  });

  it.each([
    { type: "bearer" },
    { type: "header", name: "X-Api-Key" },
    { type: "basic", username: "api-user" },
    { type: "login" },
  ])("still requires a valid HTTPS origin for %j", (auth) => {
    const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });
    for (const schema of [BotSecretDestination, relaxed]) {
      expect(schema.safeParse({ name: "api", auth }).success).toBe(false);
      expect(schema.safeParse({ name: "api", origin: "", auth }).success).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "http://api.example.test", auth }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "https://api.example.test/path", auth }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "https://api.example.test", auth }).success,
      ).toBe(true);
    }
    const missing = BotSecretDestination.safeParse({ name: "api", auth });
    expect(missing.error?.issues[0]?.message).toBe(BOT_SECRET_ORIGIN_MISSING_MESSAGE);
  });

  it("lets the owner input omit the origin only for a command variable", () => {
    expect(BotSecretDestinationInput.parse({ name: "cli-token", auth: command })).toEqual({
      name: "cli-token",
      origin: "",
      auth: command,
    });
    expect(
      BotSecretDestinationInput.safeParse({ name: "api", auth: { type: "bearer" } }).success,
    ).toBe(false);
    expect(
      BotSecretDestinationInput.safeParse({ name: "api", origin: "", auth: { type: "bearer" } })
        .success,
    ).toBe(false);
  });
});

describe("one-time code contracts", () => {
  it.each([
    ["482913", "482913"],
    [" 482 913 ", "482913"],
    ["G-482913", "G-482913"],
    ["1234", "1234"],
    ["abcd1234efgh", "abcd1234efgh"],
    ["123-456", "123-456"],
    ["12-34-56", "12-34-56"],
  ])("takes %j as %j", (typed, code) => {
    expect(normalizeOneTimeCode(typed)).toBe(code);
  });

  it.each([
    "",
    "   ",
    "ok",
    "123",
    "x".repeat(13),
    "12 34 56 78 90 12 3",
    "----",
    "1---",
    "a-b-",
    "-1234",
    "12--34",
    "1-2-3",
    "12.34",
    "12_34",
    "١٢٣٤٥٦",
  ])("takes %j as no code", (typed) => {
    expect(normalizeOneTimeCode(typed)).toBeUndefined();
  });

  describe("reading a code out of an email", () => {
    const read = (text: string, subject = "Sign in") => extractOneTimeCode({ subject, text });

    it.each([
      ["six digits", "Your verification code is 482913.", "482913"],
      ["eight digits", "Code: 48291375", "48291375"],
      ["a code split by a space", "Your code: 482 913", "482913"],
      ["a code split by a dash", "Your code: 482-913", "482913"],
      ["eight digits in two groups", "Passcode 4829 1375", "48291375"],
      ["letters and digits", "Use code K7Q2M9 to sign in.", "K7Q2M9"],
      ["a code after its cue", "482913 is your one-time password", "482913"],
      ["a code on a line of its own under its cue", "Your code:\n\n  482913\n\nThanks", "482913"],
      [
        "a code on a line of its own over its cue",
        "Hi,\n482913\nEnter this code to sign in.",
        "482913",
      ],
    ])("finds %s", (_name, text, code) => {
      expect(read(text)).toBe(code);
    });

    it("takes a number on a line of its own only with a cue in the subject or the next line", () => {
      expect(read("Order number\n48213377\n")).toBeUndefined();
      expect(read("Hi,\n\n  482913\n\nThanks")).toBeUndefined();
      expect(read("Hi,\n\n  482913\n\nThanks", "Your sign-in code")).toBe("482913");
      // Only the nearest line with text on it, not a cue further away.
      expect(read("Your code is below.\nOrder number\n48213377\n")).toBeUndefined();
    });

    it.each([
      ["four digits", "Your code: 4829"],
      ["five digits", "Code 48291, valid for 10 minutes."],
    ])("takes no code of %s, which could not be hidden on its own", (_name, text) => {
      expect(read(text)).toBeUndefined();
      expect(read("Welcome back.", text)).toBeUndefined();
      // Still a second code, so the email is not read as holding one.
      expect(read(`${text}\nYour code is 731905.`)).toBeUndefined();
    });

    it.each([
      ["en", "Your verification code is 482913."],
      ["de", "Ihr Bestätigungscode lautet 482913."],
      ["es", "Tu código de verificación es 482913."],
      ["fr", "Mot de passe à usage unique : 482913"],
      ["he", "קוד האימות שלך הוא 482913"],
      ["hi", "आपका सत्यापन कोड 482913 है।"],
      ["ja", "認証コードは482913です。"],
      ["ko", "인증번호는 482913입니다."],
      ["nl", "Je verificatiecode is 482913."],
      ["pl", "Twój kod weryfikacyjny to 482913."],
      ["pt-BR", "Seu código de verificação é 482913."],
      ["ru", "Ваш код подтверждения: 482913"],
      ["tr", "Doğrulama kodunuz: 482913"],
      ["zh-CN", "您的验证码是482913，5分钟内有效。"],
      ["zh-TW", "您的驗證碼為482913。"],
    ])("finds a code by its cue in %s", (_language, text) => {
      expect(read(text)).toBe("482913");
    });

    it.each([
      ["an order number", "Your order 12345 has shipped."],
      ["a postal code", "Mountain View, CA 94043"],
      ["a postal code named as one", "ZIP code: 94043"],
      ["a promo code", "Use promo code SAVE2026 at checkout."],
      ["a number with no cue", "Enter 4829 to continue."],
    ])("does not take %s with no code cue next to it", (_name, text) => {
      expect(read(text)).toBeUndefined();
      expect(read(`${text}\nYour code is 731905.`)).toBe("731905");
    });

    it("takes a number in the subject only when the subject names a code", () => {
      expect(read("Welcome back.", "Order 482913 confirmed")).toBeUndefined();
      expect(read("Welcome back.", "482913 is your sign-in code")).toBe("482913");
    });

    it("finds the code in the subject, also when the text repeats it", () => {
      expect(read("Welcome back.", "482913 is your sign-in code")).toBe("482913");
      expect(read("Your code is 482 913.", "482913 is your sign-in code")).toBe("482913");
    });

    it.each([
      ["six digits", "Your code: 482913", "482913"],
      ["eight digits", "Your code: 48291375", "48291375"],
      ["six digits spaced", "Your code: 482 913", "482 913"],
      ["six digits dashed", "Your code: 482-913", "482-913"],
      ["eight digits spaced", "Your code: 4829 1375", "4829 1375"],
      ["eight digits dashed", "Your code: 4829-1375", "4829-1375"],
      ["letters and digits", "Your code: K7Q2M9", "K7Q2M9"],
    ])("names %s as written among the code's writings", (_name, text, written) => {
      for (const email of [
        { subject: "Sign in", text },
        { subject: text, text: "Welcome back." },
      ]) {
        const code = extractOneTimeCode(email);
        expect(code).toBe(written.replace(/[ -]/g, ""));
        expect(oneTimeCodeWritings(code!)).toContain(written);
      }
    });

    it.each([
      ["a year", "© 2026 Example Inc. All rights reserved."],
      ["a date", "Sent on 2026-11-10 at 10:30."],
      ["a phone number", "Not you? Call +1 (555) 123-4567 or 555 123 4567."],
      ["an international phone number", "Call us on +44 7700 900123."],
      ["an order number", "Order #48213977 has shipped."],
      ["an amount", "You paid $1234.56, or 1,234.56 EUR."],
      ["a number in a link", "Verify at https://example.test/verify?token=482913&id=5512"],
      ["three digits", "Room 123."],
      ["nine digits", "Account 482913755."],
      ["lowercase letters and digits", "Plays mp4 and h264 files, like abc123."],
    ])("does not take %s for a code", (_name, text) => {
      expect(read(`${text}\nYour code is 731905.`)).toBe("731905");
      expect(read(text)).toBeUndefined();
      // Not even with a cue next to it.
      expect(read(`Your code: ${text}`)).toBeUndefined();
    });

    it("finds nothing in an email without a code", () => {
      expect(
        read("Thanks for signing up. Click the link to confirm your address."),
      ).toBeUndefined();
    });

    it("finds nothing when the email holds two different codes", () => {
      expect(read("Your code is 482913. Your previous code 731905 has expired.")).toBeUndefined();
      expect(read("Order 48213977 is ready. Your code is 731905.")).toBeUndefined();
      expect(read("Your code is 731905.", "Your code is 482913")).toBeUndefined();
    });
  });

  describe("hiding a taken code in email text", () => {
    it.each([
      ["as is", "482913"],
      ["with a no-break space", "482\u00a0913"],
      ["with a narrow no-break space", "482\u202f913"],
      ["with dots", "4.8.2.9.1.3"],
      ["with a double space", "482  913"],
      ["on separate lines", "4\n8\n2\n9\n1\n3"],
      ["with a middle dot and an en dash", "48·29–13"],
    ])("hides it written %s", (_name, written) => {
      expect(hideOneTimeCodeInEmail(`Code: ${written}!`, "482913")).toBe("Code: [redacted]!");
    });

    it("hides letters in either case, and nothing but the code's characters in order", () => {
      expect(hideOneTimeCodeInEmail("k7 q2 M9", "K7Q2M9")).toBe("[redacted]");
      expect(hideOneTimeCodeInEmail("4829, 13 and 482_913", "482913")).toBe("4829, 13 and 482_913");
    });

    it("stays linear on a long run of separators", () => {
      const text = `${"4".repeat(5)}${" ".repeat(200_000)}x`;
      const started = performance.now();
      expect(hideOneTimeCodeInEmail(text, "444444")).toBe(text);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });

  it("is for an HTTPS origin only, never a path, credentials or plain HTTP", () => {
    expect(OneTimeCodeTarget.safeParse({ origin: "https://login.example.test" }).success).toBe(
      true,
    );
    for (const origin of [
      "http://login.example.test",
      "http://192.168.1.20",
      "https://user:pass@example.test",
      "https://login.example.test/verify",
      "",
    ]) {
      expect(OneTimeCodeTarget.safeParse({ origin }).success).toBe(false);
    }
  });
});
