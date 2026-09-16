#import <React/RCTBridgeModule.h>
#import <Security/Security.h>

// A device identity that survives the app being deleted and reinstalled.
//
// The SDK's own device id lives in AsyncStorage, which iOS wipes along with the
// app container on uninstall. Reinstalling therefore produced a brand-new
// anonymous device every time, with no way for the backend to tell it was the
// same phone — installs were double-counted and a user who had logged in before
// came back as a stranger.
//
// The Keychain is the one store that outlives the container, which is why every
// attribution SDK uses it for this. We keep a random UUID there: it identifies
// the install lineage to this app and nothing else, and carries no hardware or
// advertising identifier.
//
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly is deliberate on both halves:
//   · AfterFirstUnlock  — readable when the app is launched into the background
//                         (push, background fetch), unlike WhenUnlocked.
//   · ThisDeviceOnly    — never syncs to iCloud Keychain. Without it a user's
//                         iPad would restore the iPhone's id and the two devices
//                         would collapse into one row.
@interface NohmoStableId : NSObject <RCTBridgeModule>
@end

@implementation NohmoStableId

RCT_EXPORT_MODULE()

// No UI and no bridge-startup work, so let RN initialise this lazily off the
// main thread.
+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

static NSString *const NohmoStableIdService = @"in.nohmo.sdk";
static NSString *const NohmoStableIdAccount = @"stable_id";

static NSMutableDictionary *NohmoStableIdQuery(void)
{
  return [@{
    (__bridge id)kSecClass:       (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: NohmoStableIdService,
    (__bridge id)kSecAttrAccount: NohmoStableIdAccount,
  } mutableCopy];
}

RCT_EXPORT_METHOD(getStableId:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSMutableDictionary *read = NohmoStableIdQuery();
  read[(__bridge id)kSecReturnData] = @YES;
  read[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;

  CFTypeRef found = NULL;
  OSStatus readStatus = SecItemCopyMatching((__bridge CFDictionaryRef)read, &found);
  if (readStatus == errSecSuccess && found != NULL) {
    NSData *data = (__bridge_transfer NSData *)found;
    NSString *existing = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
  }

  NSString *fresh = [[NSUUID UUID] UUIDString];

  // Clear first: a zero-length or otherwise unreadable item would make SecItemAdd
  // fail with errSecDuplicateItem forever, permanently wedging this device on the
  // no-id path.
  SecItemDelete((__bridge CFDictionaryRef)NohmoStableIdQuery());

  NSMutableDictionary *write = NohmoStableIdQuery();
  write[(__bridge id)kSecValueData] = [fresh dataUsingEncoding:NSUTF8StringEncoding];
  write[(__bridge id)kSecAttrAccessible] =
      (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;

  OSStatus addStatus = SecItemAdd((__bridge CFDictionaryRef)write, NULL);
  if (addStatus != errSecSuccess) {
    // Nothing was persisted, so this UUID would differ on every launch. Sending it
    // would stamp a fresh stable_id on each run and defeat the matching it exists
    // for — an empty string tells the SDK to send no stableId at all.
    resolve(@"");
    return;
  }

  resolve(fresh);
}

@end
