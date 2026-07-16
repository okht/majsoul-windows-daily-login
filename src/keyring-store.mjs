import keyring from "@napi-rs/keyring";

const { Entry } = keyring;

export function keyringStore(EntryType = Entry) {
  return {
    get(service, account) {
      return new EntryType(service, account).getPassword();
    },

    set(service, account, value) {
      return new EntryType(service, account).setPassword(value);
    },

    delete(service, account) {
      return new EntryType(service, account).deletePassword();
    }
  };
}
