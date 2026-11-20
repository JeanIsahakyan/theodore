# Push contract (cloud -> phone)

The cloud sends through the Expo Push API (`https://exp.host/--/api/v2/push/send`).
`contract.ts` is the reference: `askPresentation(question, options)` returns the
`body` and `categoryId` the cloud must send; copy its logic.

## Message

| Field        | Value                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `to`         | the device's Expo push token                                                                         |
| `title`      | `"<host> · <space>"`                                                                                 |
| `body`       | ask: `askPresentation(...).body` (≤ 180 chars). finished: a short line                               |
| `categoryId` | ask: `askPresentation(...).categoryId`; omit for finished and for multi-question / multi-select asks |
| `channelId`  | `"default"` (Android; the app creates it)                                                            |
| `priority`   | `"high"` for asks                                                                                    |
| `sound`      | omit (silent banner)                                                                                 |
| `data`       | below                                                                                                |

```
data: {
  kind:        "ask" | "finished",
  ask_id:      string,        // "" / omitted for finished
  space:       string,
  host_device: string,        // device id of the computer running the space
  options:     string[]       // first question's options, <= 4; [] for free text
}
```

`categoryId` is the Expo Push API name; on the device it is the notification's
category. Total payload stays under 4 KiB.

### Confirm (Claude via cloud waits on a computer)

| Field        | Value                                     |
| ------------ | ----------------------------------------- |
| `title`      | `"Claude via cloud · <host>"`             |
| `body`       | `"wants to <what>: <text>"` (≤ 180 chars) |
| `categoryId` | `"confirm"`                               |
| `data`       | below                                     |

```
data: {
  kind:        "confirm",
  confirm_id:  string,        // the RemoteConfirm's confirm_id
  host_device: string,        // the computer it waits on (pinned here)
  space:       "",
  ask_id:      "",
  options:     []
}
```

## Categories (registered at startup by `setupNotifications`)

| `categoryId` | Buttons                   | Use when                                 |
| ------------ | ------------------------- | ---------------------------------------- |
| `ask_opt2`   | `1`, `2`, Reply (text)    | exactly 2 options                        |
| `ask_opt3`   | `1`, `2`, `3`             | exactly 3 options                        |
| `ask_text`   | Reply (text), Open        | 0, 1 or 4 options, or options too long   |
| `confirm`    | Deny (destructive), Allow | a `confirm` push                         |
| none         | tap only                  | `finished`, multi-question, multi-select |

Body for `ask_optN`: `<question>\n1) <opt>  2) <opt> ...` (options cut to fit,
question cut to keep 180).

## Why this shape

Expo categories are registered once, by the app, with fixed button titles. A
push can only name a category; it cannot set button titles. Registering
categories per question is not possible (iOS reads them at launch, and a push
arriving while the app is killed uses what was registered last). So:

- Option buttons are generic numbers; the body says what each number means.
  The app maps `opt<i>` to `data.options[i]`, so the answer is the real text.
- Android shows at most three action buttons, so three option buttons is the
  cap on both platforms; a fourth option goes through Reply or Open.
- Reply (a text input) always answers any single question; Open is the
  fallback. Answering never guesses: an unknown button or empty text opens the
  space instead.

## What the app does with a response

```
tap body / Open        ─▶ navigate(/space/<space>)
button 1..3            ─▶ fleet.answerOverHttp(space, ask_id, [[options[i]]], host_device)
Reply (text)           ─▶ fleet.answerOverHttp(space, ask_id, [[text]], host_device)
answer fails           ─▶ local notification "Couldn't send your answer", tap opens the space
confirm: Allow / Deny  ─▶ fleet.confirmOverHttp(host_device, confirm_id, allow)
confirm: tap body      ─▶ navigate(/)  (Home, where the card waits)
confirm fails          ─▶ the same local notification, tap opens Home
```

Button and Reply actions do not open the app (`opensAppToForeground: false`),
Allow and Deny neither. A confirm push is bannered even while a space is on
screen. A late Allow / Deny (answered elsewhere, or expired) is refused by the
computer later; the phone shows nothing for it.

## Background and killed state

|                              | iOS                                                                                                                                                                                                                               | Android                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground                   | listener fires, banner (not for the space on screen)                                                                                                                                                                              | same                                                                                                                                                     |
| Backgrounded, action pressed | app gets a background launch window, listener answers                                                                                                                                                                             | same                                                                                                                                                     |
| Killed, action pressed       | iOS relaunches the app in the background; the response is replayed from `getLastNotificationResponseAsync` once JS runs and `handleNotificationResponses` is wired. Needs a real device to confirm it completes inside the window | Same replay. Expo's headless task (`registerTaskAsync` + `expo-task-manager`) would run it without launching the UI, not used yet (needs the dependency) |
| Killed, body tapped          | app opens, replay navigates                                                                                                                                                                                                       | same                                                                                                                                                     |

Requirement on the fleet client: `answerOverHttp` must load the stored session
and device key itself (it can be the first thing to run after a cold start).

## Needs a real device to verify

- An EAS `projectId` (`extra.eas.projectId` in app.json, from `eas init`);
  without it `registerForPush` logs and does nothing.
- iOS: Apple developer account, push entitlement (added by the plugin), an EAS
  build with credentials; simulators get no token.
- Android: a Firebase project, `google-services.json` (`android.googleServicesFile`),
  FCM v1 credentials uploaded to EAS.
- Action buttons killed/backgrounded on iOS, text Reply on both, and the
  Android 13+ permission prompt.
