// A key and a self-signed certificate for TEST SERVERS ONLY: nothing trusts them and nothing
// real is protected by them. Node cannot issue X.509 certificates, so these were made once with
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
//     -subj "/CN=cal.example.org" -addext "subjectAltName=DNS:localhost,DNS:cal.example.org,IP:127.0.0.1"
// (valid for 100 years) so a test can start a local TLS server without openssl on the machine.
export const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkcC/R7U9zvZHLXUF
fNL06mtzUKCrzSOYfTVXJ6R3w0OhRANCAAS9S0rXP0Jc1Q3qeAym0isRlFIQK0x9
kSOZlFYp5WpJ08IkovgiimDAV7rpfFIH20NABLtkgaPDcZbBUYMn3GAK
-----END PRIVATE KEY-----
`;

export const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIUPOiOt81DyI2bKWSnPM+c8yiRSucwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPY2FsLmV4YW1wbGUub3JnMCAXDTI2MTExMzIwMjMwNVoYDzIx
MjYxMDIwMjAyMzA1WjAaMRgwFgYDVQQDDA9jYWwuZXhhbXBsZS5vcmcwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAS9S0rXP0Jc1Q3qeAym0isRlFIQK0x9kSOZlFYp
5WpJ08IkovgiimDAV7rpfFIH20NABLtkgaPDcZbBUYMn3GAKo18wXTAdBgNVHQ4E
FgQUwKkkz0LlVGqOo+/m5MgN5GFwCMkwDwYDVR0TAQH/BAUwAwEB/zArBgNVHREE
JDAigglsb2NhbGhvc3SCD2NhbC5leGFtcGxlLm9yZ4cEfwAAATAKBggqhkjOPQQD
AgNIADBFAiBAHyMipJxeBRMoWxhRh1AFHSmtGaSr3lEyUCyC5OxaaAIhAJWaRwXR
dw/q3PdGhKTJ9857eDVKSZXRpbVVen431vTw
-----END CERTIFICATE-----
`;
