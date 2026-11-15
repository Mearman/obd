# Vehicle communication notes

How to talk to vehicles through the diagnostic port with an ELM327 or STN style adapter, written so any car can be added to `obd-read` as a profile. Start with [generic-standards.md](generic-standards.md), then the make or region that matches the car.

- [generic-standards.md](generic-standards.md): connector, legislated protocols, ELM327 and STN commands, ISO-TP, UDS and KWP2000.
- [mercedes-benz.md](mercedes-benz.md)
- [mercedes-compact.md](mercedes-compact.md): A-Class, B-Class, CLA, GLA and Citan.
- [vag-group.md](vag-group.md): Volkswagen, Audi, SEAT, Skoda, Porsche.
- [bmw-mini.md](bmw-mini.md)
- [ford-gm-stellantis.md](ford-gm-stellantis.md)
- [japan-korea.md](japan-korea.md)
- [europe-other.md](europe-other.md): Renault, PSA, Fiat, Volvo, Jaguar Land Rover and others.

Every claim carries its source inline. Anything marked "unconfirmed" was not settled by a source that could be read, and a profile built on it must be verified at the car. These notes cover reading only; coding, adaptation and flashing are out of scope.
