# Himalaya Configuration Reference

Configuration file location: `~/.config/himalaya/config.toml` (also searched: `$XDG_CONFIG_HOME/himalaya/config.toml`, `~/.himalayarc`; full schema: [config.sample.toml](https://github.com/pimalaya/himalaya/blob/master/config.sample.toml)).

## Minimal IMAP + SMTP Setup

```toml
[accounts.default]
email = "user@example.com"
display-name = "Your Name"
default = true

# IMAP backend for reading emails
imap.server = "imaps://imap.example.com:993"
imap.sasl.plain.username = "user@example.com"
imap.sasl.plain.password.raw = "your-password"

# SMTP backend for sending emails
smtp.server = "smtp://smtp.example.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "user@example.com"
smtp.sasl.plain.password.raw = "your-password"
```

## Password Options

### Raw password (testing only, not recommended)

```toml
imap.sasl.plain.password.raw = "your-password"
```

### Password from command (recommended)

Native keyring support was removed in v2; use a password-manager CLI (`pass`, `secret-tool`, `gopass`, macOS `security`, ...) via `.command`:

```toml
imap.sasl.plain.password.command = "pass show email/imap"
# imap.sasl.plain.password.command = "security find-generic-password -a user@example.com -s imap -w"
```

The same shape applies to SMTP under `smtp.sasl.plain`. `himalaya configure` runs an interactive account-setup wizard.

## Gmail Configuration

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.plain.username = "you@gmail.com"
imap.sasl.plain.password.command = "pass show google/app-password"

smtp.server = "smtp://smtp.gmail.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "you@gmail.com"
smtp.sasl.plain.password.command = "pass show google/app-password"
```

**Note:** Gmail requires an App Password if 2FA is enabled. v2 also ships a native Gmail REST backend (`gmail.auth.token.*`, OAuth via [ortie](https://github.com/pimalaya/ortie)); the example above uses plain IMAP + SMTP with an app password.

## iCloud Configuration

```toml
[accounts.icloud]
email = "you@icloud.com"
display-name = "Your Name"

imap.server = "imaps://imap.mail.me.com:993"
imap.sasl.plain.username = "you@icloud.com"
imap.sasl.plain.password.command = "pass show icloud/app-password"

smtp.server = "smtp://smtp.mail.me.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "you@icloud.com"
smtp.sasl.plain.password.command = "pass show icloud/app-password"
```

**Note:** Generate an app-specific password at appleid.apple.com

## Mailbox Aliases

Map friendly names to backend-native mailbox ids. v2 renamed the v1 `[folder.alias]` block; use `[mailbox.alias]` (global) or `[accounts.<name>.mailbox.alias]` (account-level, overrides global). Entries named after a role (`inbox`, `sent`, `drafts`, `trash`, ...) also override the role the backend reports, and `inbox` is the default mailbox used when `-m/--mailbox` is omitted:

```toml
[accounts.default.mailbox.alias]
inbox = "INBOX"
sent = "Sent"
drafts = "Drafts"
trash = "Trash"
```

## Multiple Accounts

```toml
[accounts.personal]
email = "personal@example.com"
default = true
# ... backend config ...

[accounts.work]
email = "work@company.com"
# ... backend config ...
```

Switch accounts with `--account`:

```bash
himalaya --account work envelope list
```

## Notmuch Backend

Removed in v2 (may return in a future release). For local mail, use the `maildir`, `m2dir` or `pimdir` backends instead.

## OAuth2 Authentication (for providers that support it)

v2 dropped the built-in OAuth2 flow. Route an access token through SASL `oauthbearer` (or `xoauth2` for Google), and produce the token with an external broker such as [pimalaya/ortie](https://github.com/pimalaya/ortie):

```toml
imap.sasl.oauthbearer.username = "user@example.com"
imap.sasl.oauthbearer.token.command = ["ortie", "token", "show", "-a", "example"]
```

## Additional Options

### Signature

```toml
[accounts.default]
signature = "Best regards,\nYour Name"
signature-delim = "-- \n"
```

### Downloads directory

```toml
[accounts.default]
downloads-dir = "~/Downloads/himalaya"
```

### Composition

Composition left the CLI in v2; use an external composer such as [pimalaya/mml](https://github.com/pimalaya/mml), chained into `himalaya message send` / `himalaya message add`.
