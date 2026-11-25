# Sign-in and upgrade card funnels

Group image and video cards by `studio_id`, `scene_id` and `offer_kind` (for example,
`design / remove-background`). Settings cards use `page_name=settings`, `area=account`
and `settings_section=account|subscription`. Each section visit has its own ID.
If sign-in reveals an upgrade card within the same visit, each kind qualifies separately.
Count distinct OpenMotion installations within each group. Signed-out viewers have no
confirmed account identity. One person using two installations can appear twice.

| Stage | Event | Unit and source |
| --- | --- | --- |
| Card seen | OpenMotion `surface_view`, `element=card`, `area=asset_create` for generators or `area=account` for settings | Half of the card visible continuously for one second in the foreground. Once per card kind and entry visit. Changing the model or toggling providers in the same visit keeps its ID. |
| Button clicked | OpenMotion `ui_click`, same area and visit | `element=sign_in` or `view_plans`. Both events carry `offer_kind=sign_in\|upgrade` and `offer_visit_id`. Each activation gets a fresh `entry_id`. A quick click can precede a qualified exposure. |
| Sign-in succeeded | OpenMotion `account_sign_in_result`, `outcome=success` | Join the login click's `entry_id` to the connector's completed result on the same installation. |
| Subscription paid | AMR `billing_payment_result`, `result=success` | Join the upgrade click's `entry_id` to a positive, initial or upgrade subscription payment. The system-browser handoff and the fallback URL carry the same ID as `od_entry_id`. |

## Run the entry report

Export the following **two read-only SQL queries as CSV with headers**. At verification
time, OpenMotion Studio events with `product=openmotion` were received by the
[OpenDesign project](https://us.posthog.com/project/420348), and subscription receipts
by the [AMR project](https://us.posthog.com/project/440658). Use a private working
directory. Keep the same reporting period across both exports and split large time
ranges into shorter complete exports if a query or download row limit is reached.
The examples use the last seven days up to query time. A report is provisional
while later outcomes may still arrive. For a closed cohort keep the exposure/click
range fixed and extend the result and payment ranges through the desired cutoff.

**OpenDesign → `motion.csv`**

```sql
SELECT event, toUnixTimestamp64Milli(timestamp) AS ts, distinct_id AS installation,
       if(properties.page_name = 'settings', 'settings', properties.studio_id) AS surface,
       if(properties.page_name = 'settings', properties.settings_section, properties.scene_id) AS entry_point,
       properties.offer_kind AS card, properties.offer_visit_id AS visit,
       properties.entry_id AS entry
FROM events
WHERE properties.product = 'openmotion' AND properties.env = 'production'
  AND empty(toString(coalesce(properties.test_run_id, '')))
  AND timestamp >= now() - INTERVAL 7 DAY
  AND ((event IN ('surface_view','ui_click') AND properties.offer_kind IN ('sign_in','upgrade')
        AND ((properties.page_name = 'creative_studio' AND properties.area = 'asset_create')
          OR (properties.page_name = 'settings' AND properties.area = 'account'
              AND properties.settings_section IN ('account','subscription')))
        AND ((event = 'surface_view' AND properties.element = 'card')
          OR (event = 'ui_click' AND ((properties.element = 'sign_in' AND properties.offer_kind = 'sign_in')
                                  OR (properties.element = 'view_plans' AND properties.offer_kind = 'upgrade')))))
       OR (event = 'account_sign_in_result' AND properties.outcome = 'success'))
ORDER BY timestamp, uuid
LIMIT 100000
```

**AMR → `paid.csv`**

```sql
SELECT properties.entry_id AS entry, toUnixTimestamp64Milli(timestamp) AS ts
FROM events
WHERE event = 'billing_payment_result' AND properties.env = 'production'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND properties.result = 'success' AND properties.payment_scene = 'subscription'
  AND properties.payment_kind IN ('subscription_initial', 'subscription_upgrade')
  AND toFloat64OrZero(toString(properties.amount_paid_usd)) > 0
  AND notEmpty(toString(coalesce(properties.entry_id, '')))
ORDER BY timestamp, uuid
LIMIT 100000
```

With both CSVs in the current directory, run the following in SQLite (`sqlite3 :memory:`).
The report shows total clickers separately from the ordered funnel. The last three
columns use the same exposed installation cohort. Repeat clicks or payment
notifications count once per installation per row. Results join through the clicked
entry only. Missing payment attribution stays outside the conversion count.

```sql
.mode csv
.import motion.csv motion
.import paid.csv paid
.headers on
.mode column
WITH seen AS (
  SELECT installation, surface, entry_point, card, visit, min(CAST(ts AS INTEGER)) AS first_seen
  FROM motion WHERE event = 'surface_view' GROUP BY installation, surface, entry_point, card, visit
), clicks AS (
  SELECT installation, surface, entry_point, card, visit, entry, CAST(ts AS INTEGER) AS clicked
  FROM motion WHERE event = 'ui_click' AND entry <> ''
), results AS (
  SELECT 'sign_in' AS card, installation, entry, CAST(ts AS INTEGER) AS completed
  FROM motion WHERE event = 'account_sign_in_result' AND entry <> ''
  UNION ALL
  SELECT 'upgrade', NULL, entry, CAST(ts AS INTEGER) FROM paid WHERE entry <> ''
), entries AS (
  SELECT surface, entry_point, card FROM seen UNION SELECT surface, entry_point, card FROM clicks
), visits AS (
  SELECT s.*, c.clicked, r.completed
  FROM seen s LEFT JOIN clicks c USING (installation, surface, entry_point, card, visit)
  LEFT JOIN results r ON r.card = c.card AND r.entry = c.entry AND r.completed >= c.clicked
                     AND (r.installation IS NULL OR r.installation = c.installation)
)
SELECT e.surface, e.entry_point, e.card,
       (SELECT count(DISTINCT c.installation) FROM clicks c
        WHERE c.surface=e.surface AND c.entry_point=e.entry_point AND c.card=e.card) AS all_clickers,
       count(DISTINCT v.installation) AS exposed,
       count(DISTINCT CASE WHEN v.clicked >= v.first_seen THEN v.installation END) AS clicked_after_view,
       count(DISTINCT CASE WHEN v.clicked >= v.first_seen AND v.completed IS NOT NULL THEN v.installation END) AS succeeded
FROM entries e LEFT JOIN visits v USING (surface, entry_point, card)
GROUP BY e.surface, e.entry_point, e.card ORDER BY e.surface, e.entry_point, e.card;
```

Exclude free grants, zero-amount invoices, wallet recharges and renewals. Returning
to Studio or loading a new plan balance does not confirm a purchase. An upgrade
initiated elsewhere or a receipt without the click's entry ID cannot be attributed
to this card. Manage subscription, retry controls and header Pricing are separate actions. A fallback browser link continues the original upgrade click.
