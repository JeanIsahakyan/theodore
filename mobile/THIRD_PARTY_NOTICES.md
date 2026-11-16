# Third-party notices

## chat-template by Evan Bacon

https://github.com/EvanBacon/chat-template

The app's shell, composer, chat, markdown renderer, and the look of
Settings and Devices are adapted from it. Each derived file starts with the
line `Adapted from EvanBacon/chat-template (MIT)`.

| File (mobile/) | From (template src/) |
| --- | --- |
| `metro.config.js` | `metro.config.js` |
| `src/global.css` | `global.css` |
| `src/components/tw.tsx` | `components/tw.tsx` |
| `src/components/symbol-image.tsx` | `components/symbol-image.tsx`, `components/icon.tsx` |
| `src/components/touchable-glass.tsx` | `components/touchable-glass.tsx` |
| `src/components/blur-raw.tsx`, `.android.tsx`, `.web.tsx` | `components/blur-raw.tsx`, `.web.tsx` |
| `src/components/grabber.tsx`, `.android.tsx` | `components/grabber.tsx`, `.android.tsx` |
| `src/components/drawer-layout.tsx` | `components/drawer-layout.tsx` |
| `src/components/drawer-context.tsx`, `drawer-content.tsx` | `components/drawer-content.tsx` |
| `src/components/app-shell.tsx`, `.web.tsx` | `app/_layout.tsx`, `app/_layout.web.tsx`, `components/sidebar.web.tsx` |
| `src/components/main-header.tsx`, `.ios.tsx`, `.android.tsx` | `components/main-header*.tsx` |
| `app/(app)/model-picker.tsx`, `src/components/pickers/model-picker-list.tsx`, `sheet-rows.tsx` | `app/model-picker.tsx`, `app/_layout.tsx` (the formSheet), `components/model-context.tsx` |
| `src/components/chat/prompt-input.tsx`, `.web.tsx` | `components/chat/prompt-input.tsx`, `.web.tsx` |
| `src/components/chat/composer-dock.tsx`, `.web.tsx` | `components/chat/conversation.tsx` (keyboard handling) |
| `src/components/chat/index.ts` | `components/chat/index.ts` |
| `app/(app)/settings.tsx` | `app/(settings)/settings.tsx`, `app/(settings)/_layout.tsx` (grouped sections with icons, Appearance, sign out at the bottom) |
| `app/(app)/devices.tsx` | `app/(settings)/capabilities.tsx` (icon rows with a secondary line) |
| `src/components/chat/conversation.tsx`, `.web.tsx` | `components/chat/conversation.tsx`, `.web.tsx` |
| `src/components/chat/message.tsx`, `.web.tsx` | `components/chat/message.tsx`, `.web.tsx` |
| `src/components/chat/streaming-message.tsx` | `components/chat/streaming-message.tsx`, `global.css` (shimmer) |
| `src/components/markdown/index.ts`, `types.ts`, `utils.ts` | `components/markdown/index.ts`, `types.ts`, `utils.ts` |
| `src/components/markdown/parse.ts` | `components/markdown/markdown.tsx`, `utils.ts`, `chat-markdown.tsx` |
| `src/components/markdown/ast-renderer.ts`, `render-rules.tsx` | `components/markdown/ast-renderer.ts`, `render-rules.tsx` |
| `src/components/markdown/markdown.tsx`, `chat-markdown.tsx` | `components/markdown/markdown.tsx`, `chat-markdown.tsx` |
| `src/components/markdown/code-block.tsx` | `components/markdown/code-block.tsx` |
| `src/components/space-header.tsx`, `.ios.tsx`, `.android.tsx`, `space-title.tsx` | `components/main-header*.tsx` |

```text
MIT License

Copyright (c) Evan Bacon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Material Symbols

The Android vector icons in `assets/icons/` are Google's Material Symbols,
under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
https://github.com/google/material-design-icons
