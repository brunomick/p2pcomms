# Security

## Threat model

p2pcomms protects the **content** of a conversation between two people.

It protects against:

- **Relays, your ISP and other network observers.** Chat, audio and video go directly between the two browsers, encrypted by WebRTC (DTLS and SRTP). The Nostr relays only carry the encrypted handshake, and they never see the 4-word code, only a value derived from it with PBKDF2.
- **A man-in-the-middle who knows the code**, for example someone who read it in your messages, as long as you compare the verification words aloud and both see the same words. The words come from a commit-reveal exchange, so an attacker can only make them match by chance (1 in 2^44).

It does not protect against:

- **Metadata exposure.** It does not hide IP addresses. The other person, the relays and the STUN server see your IP. Relays and your ISP can see when you connect and with which IP. See the Privacy section of the [README](README.md).
- **A compromised device.** Malware, a malicious browser extension or someone with access to either computer can read the conversation.
- **A tampered HTML file.** If someone gives you a modified `p2pcomms.html`, it can do anything. Download it from the GitHub releases and check its SHA-256 hash against `SHA256SUMS` (see the README).
- **Skipping the verification words.** Until you press **Match** after comparing the words, the connection is unverified.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. This creates a private security advisory that only the maintainer can see.

Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and which release or commit you tested.
