import { keyringStore } from "./keyring-store.mjs";

const SERVICE = "MajSoulDaily.Gmail";

export function credentialStore(EntryType) {
  const store = keyringStore(EntryType);
  return {
    set(account, password) {
      store.set(SERVICE, account, password);
    },
    get(account) {
      return store.get(SERVICE, account);
    },
    delete(account) {
      return store.delete(SERVICE, account);
    }
  };
}
