package iqcn

import (
	"bytes"
	"strings"
	"testing"
)

const fixtureVector = "00112233445566778899aabbccddeeff"

func descriptorPacket(text string) []byte {
	packet := bytes.Repeat([]byte{0xff}, samplePacketSize)
	packet[0], packet[1], packet[2], packet[3] = 0x47, 0, 17, 0x10
	packet[4] = 0
	copy(packet[5:], text)
	packet[5+len(text)] = 0
	return packet
}

// One complete SDT service descriptor, followed by a caller-supplied CRC.
// The CRC deliberately need not validate: these tests exercise field boundaries.
func serviceDescriptorPacket(provider, name string, crc [4]byte) []byte {
	body := append([]byte{1, byte(len(provider))}, []byte(provider)...)
	body = append(body, byte(len(name)))
	body = append(body, []byte(name)...)
	descriptor := append([]byte{0x48, byte(len(body))}, body...)
	service := []byte{0, 1, 0, 0x80 | byte(len(descriptor)>>8), byte(len(descriptor))}
	service = append(service, descriptor...)
	section := []byte{0x42, 0xb0, 0, 0, 1, 2, 0, 0, 0, 1, 1}
	section = append(section, service...)
	section = append(section, crc[:]...)
	sectionLength := len(section) - 3
	section[1] |= byte(sectionLength >> 8)
	section[2] = byte(sectionLength)
	if 5+len(section) > samplePacketSize {
		panic("service descriptor fixture exceeds one packet")
	}
	packet := bytes.Repeat([]byte{0xff}, samplePacketSize)
	packet[0], packet[1], packet[2], packet[3], packet[4] = 0x47, 0x40, 17, 0x10, 0
	copy(packet[5:], section)
	return packet
}

func TestSampleDescriptorsAcceptExplicitModeBeforeOrAfterA0(t *testing.T) {
	current := "a0|mdcm|v" + fixtureVector + "|e1|fabcdef|gv|"
	legacy := "mdcm|s1:9:10|a0|v" + fixtureVector + "|e1|fABCDEF|"
	for _, tc := range []struct {
		name   string
		packet []byte
		offset int
	}{
		{"current", descriptorPacket(current), 5},
		{"current SDT", serviceDescriptorPacket("salai", current, [4]byte{}), 31},
		{"legacy SDT", serviceDescriptorPacket("salai 4.0.3", legacy, [4]byte{}), 37},
		{"different provider length", serviceDescriptorPacket("other", legacy, [4]byte{}), 31},
	} {
		t.Run(tc.name, func(t *testing.T) {
			records, err := sampleDescriptors(tc.packet)
			if err != nil || len(records) != 1 {
				t.Fatalf("descriptor not recognized: %v", err)
			}
			got := records[0]
			if got.contentID != "abcdef" || got.offset != tc.offset {
				t.Fatalf("wrong descriptor identity/offset: %q / %d", got.contentID, got.offset)
			}
			want := [16]byte{0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb}
			if got.vector != want {
				t.Fatal("descriptor vector changed")
			}
		})
	}
}

func TestSampleDescriptorsExcludeProviderAndPrintableCRC(t *testing.T) {
	name := "mdcm|s1:9:10|a0|v" + fixtureVector + "|e1|fabcdef|"
	for _, crc := range [][4]byte{{'f', 'O', 'L', 0xfa}, {'m', 'b', 'a', 'd'}, {'{', ':', '[', '%'}, {'a', '0', '|', '|'}} {
		records, err := sampleDescriptors(serviceDescriptorPacket("a0|mwrong|", name, crc))
		if err != nil || len(records) != 1 || records[0].contentID != "abcdef" || records[0].text != name {
			t.Fatalf("provider or CRC read as descriptor text: %v / %#v", err, records)
		}
	}
	if _, err := sampleDescriptors(serviceDescriptorPacket("mdcm|", "a0|v"+fixtureVector+"|fabcdef|", [4]byte{})); err == nil {
		t.Fatal("mode leaked from the provider name")
	}
}

func TestSampleDescriptorsDoNotInferMissingOrUnsupportedModes(t *testing.T) {
	for _, packet := range [][]byte{
		descriptorPacket("a0|v" + fixtureVector + "|e1|fabcdef|"),
		descriptorPacket("unrelated=mdcm|a0|v" + fixtureVector + "|e1|fabcdef|"),
		serviceDescriptorPacket("salai 4.0.3", "a0|v"+fixtureVector+"|e1|fabcdef|", [4]byte{}),
		serviceDescriptorPacket("salai 4.0.3", "munknown|a0|v"+fixtureVector+"|e1|fabcdef|", [4]byte{}),
	} {
		if _, err := sampleDescriptors(packet); err == nil || err.Error() != "unsupported D mode" {
			t.Fatalf("unverified descriptor accepted: %v", err)
		}
	}
}

func TestSampleDescriptorsRejectInvalidSDTLengths(t *testing.T) {
	name := "mdcm|s1:9:10|a0|v" + fixtureVector + "|e1|fabcdef|"
	for _, offset := range []int{7, 20, 22, 24, 36} {
		packet := serviceDescriptorPacket("salai 4.0.3", name, [4]byte{})
		packet[offset] = 255
		if _, err := sampleDescriptors(packet); err == nil || !strings.HasPrefix(err.Error(), "invalid SDT") {
			t.Fatalf("invalid length at %d accepted or treated as clear: %v", offset, err)
		}
	}
}

func TestSampleDescriptorsKeepBinaryBoundariesAndOriginalPacketOffsets(t *testing.T) {
	first := serviceDescriptorPacket("salai 4.0.3", "mdcm|s1:9:10|", [4]byte{})
	second := descriptorPacket("a0|v" + fixtureVector + "|fabcdef|")
	if _, err := sampleDescriptors(append(first, second...)); err == nil {
		t.Fatal("mode leaked across a packet boundary")
	}
	first = descriptorPacket("a0|mdcm|v" + fixtureVector + "|fabcdef|gv|ignored")
	second = serviceDescriptorPacket("salai 4.0.3", "mdcm|s1:9:10|a0|v"+fixtureVector+"|fabcdef|", [4]byte{})
	records, err := sampleDescriptors(append(first, second...))
	if err != nil || len(records) != 2 {
		t.Fatalf("multiple descriptors not recognized: %v", err)
	}
	if records[0].offset != 5 || records[1].offset != samplePacketSize+37 || !strings.HasSuffix(records[0].text, "|gv|") {
		t.Fatal("descriptor offsets or terminator changed")
	}
}

func TestSampleDescriptorsRespectSDTPointerAndAdaptationField(t *testing.T) {
	name := "mdcm|s1:9:10|a0|v" + fixtureVector + "|fabcdef|"
	packet := serviceDescriptorPacket("salai 4.0.3", name, [4]byte{})
	// Insert a two-byte adaptation field and a two-byte pointer skip.
	copy(packet[9:], packet[5:samplePacketSize-4])
	packet[3], packet[4], packet[5], packet[6], packet[7], packet[8] = 0x30, 1, 0, 2, 0, 0
	records, err := sampleDescriptors(packet)
	if err != nil || len(records) != 1 || records[0].offset != 41 || records[0].text != name {
		t.Fatalf("wrong SDT payload offset: %v / %#v", err, records)
	}
}
