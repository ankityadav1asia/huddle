-- SMS providers that verify codes themselves (Message Central VerifyNow, Twilio Verify) return a verification id
-- when a code is sent; it is needed to check the code and is never shown to the browser.
ALTER TABLE otp_challenges ADD COLUMN provider_ref text;
-- Firebase Phone Auth was replaced by Message Central before any Firebase sign-in happened; the column is empty.
ALTER TABLE users DROP COLUMN IF EXISTS firebase_uid;
