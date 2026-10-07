import assert from "node:assert/strict";
import test from "node:test";
import {
	autoDraftEnabled,
	getAutoDraftSettings,
	mailboxAllowsAutoDraft,
	setAutoDraftSettings,
} from "../workers/lib/auto-draft.ts";

/** In-memory stand-in for the R2 bucket: just get/put of JSON objects. */
function fakeEnv(objects: Record<string, unknown> = {}) {
	const store = new Map(Object.entries(objects).map(([k, v]) => [k, JSON.stringify(v)]));
	const BUCKET = {
		async get(key: string) {
			const body = store.get(key);
			return body === undefined ? null : { json: async () => JSON.parse(body) };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
	};
	return { env: { BUCKET } as never, store };
}

test("a mailbox drafts unless its settings switch it off", () => {
	assert.equal(mailboxAllowsAutoDraft(null), true);
	assert.equal(mailboxAllowsAutoDraft({}), true);
	assert.equal(mailboxAllowsAutoDraft({ autoDraft: { enabled: true } }), true);
	assert.equal(mailboxAllowsAutoDraft({ autoDraft: {} }), true);
	assert.equal(mailboxAllowsAutoDraft({ autoDraft: { enabled: false } }), false);
});

test("the account-wide switch is on until turned off, and the change is stored", async () => {
	const { env, store } = fakeEnv();
	assert.deepEqual(await getAutoDraftSettings(env), { enabled: true });
	assert.deepEqual(await setAutoDraftSettings(env, { enabled: false }), { enabled: false });
	assert.deepEqual(await getAutoDraftSettings(env), { enabled: false });
	assert.equal(store.get("settings/auto-draft.json"), JSON.stringify({ enabled: false }));
	// A patch without a boolean leaves the switch as it is.
	assert.deepEqual(await setAutoDraftSettings(env, {}), { enabled: false });
});

test("new mail is drafted only when both the account and the mailbox allow it", async () => {
	const mailbox = "me@example.com";
	const key = `mailboxes/${mailbox}.json`;
	const cases: [Record<string, unknown>, boolean][] = [
		[{ [key]: { fromName: "Me" } }, true],
		[{ [key]: { autoDraft: { enabled: false } } }, false],
		[{ [key]: {}, "settings/auto-draft.json": { enabled: false } }, false],
		[{ [key]: { autoDraft: { enabled: true } }, "settings/auto-draft.json": { enabled: true } }, true],
	];
	for (const [objects, expected] of cases) {
		assert.equal(await autoDraftEnabled(fakeEnv(objects).env, mailbox), expected, JSON.stringify(objects));
	}
});
