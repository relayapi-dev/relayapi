# Posts Page Improvements

Tracking the small UX fixes requested for the `apps/app` Posts page (`/app/posts`).

## Checklist

- [x] **Month as default view**
  Default calendar period is `month` instead of `week`. Changed the search-param fallback in `getPostsPageRouteState` (`apps/app/src/lib/dashboard-page.ts`) and the `initialCalendarPeriod` default in `PostsPage`.

- [x] **Rework calendar header layout**
  - **Today** sits to the right of the `Month Year` label, styled as an outline button (not a ghost link).
  - The **Week / Month** switcher now sits on the right side of the header next to the **Drafts** button, with matching outline styling.
  - Edited `apps/app/src/components/dashboard/calendar/calendar-header.tsx`.

- [x] **Bottom padding in month / week / list views**
  `PostsPage` root now applies `pb-16` by default and `pb-4` when the calendar is in week view (week view already scrolls internally via `max-height: calc(-13rem + 100vh)` so it needs less outer breathing room).
  Edited `apps/app/src/components/dashboard/pages/posts-page.tsx`.

- [x] **Persist view type + date across tabs**
  Lifted `currentDate` and the period-change handler up to `PostsPage` so they survive tab switches. `CalendarView` is now a controlled component: it receives `period`, `onPeriodChange`, `currentDate`, `onDateChange` as props instead of holding its own state.
  `viewMode` and `calendarPeriod` already lived at the `PostsPage` level; the period handler now also writes `localStorage` + URL `period` param (previously that lived inside `CalendarView`).
  Edited `apps/app/src/components/dashboard/calendar/calendar-view.tsx` and `apps/app/src/components/dashboard/pages/posts-page.tsx`.

- [x] **Published tab: Unknown author + missing media**
  Root cause: `sent-post-list.tsx` was dropping `account_name` and `account_avatar_url` for `source === "external"` posts, so `SentPostCard` fell back to "Unknown" with a blank avatar. Also, when an external post only had `media_urls` (no separate `thumbnail_url`, typical for Instagram images), the mapped objects lacked a `type` hint so the card couldn't distinguish video vs image.
  Fix:
  - Added `account_name` / `account_avatar_url` to the `SentPost` type and mapped them onto the flat card's `target.displayName` / `target.avatarUrl`.
  - Mapped `media_urls` entries with the post's `media_type`, so the video thumbnail rendering path works when there's no dedicated `thumbnail_url`.
  - Edited `apps/app/src/components/dashboard/pages/posts/sent-post-list.tsx`.

## Verification

- `bun run typecheck` passes across all workspaces.
- Browser verification for each item is still needed (manual check).
