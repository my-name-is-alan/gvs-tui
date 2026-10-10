package iqcn

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

const samplePacketSize = 188

type SampleFailure struct {
	PES    int `json:"pes"`
	Unit   int `json:"unit"`
	Length int `json:"length"`
	Code   int `json:"code"`
}
type SampleReport struct {
	Units          int             `json:"units"`
	Passed         int             `json:"passed"`
	ClearUnits     int             `json:"clear_units,omitempty"`
	Failures       []SampleFailure `json:"failures,omitempty"`
	Descriptors    int             `json:"descriptors"`
	Switches       int             `json:"switches"`
	Bytes          int             `json:"bytes"`
	SHA256         string          `json:"sha256"`
	IdentitySource string          `json:"identity_source,omitempty"`
}
type sampleDescriptor struct {
	offset    int
	text      string
	vector    [16]byte
	contentID string
}
type samplePES struct {
	offset int
	data   []byte
}
type sampleUnit struct{ start, body, end int }

func parseSampleDescriptor(text string, offset int) (sampleDescriptor, error) {
	if end := strings.Index(text, "|gv|"); end >= 0 {
		text = text[:end+4]
	}
	d := sampleDescriptor{offset: offset, text: text}
	var mode, vector string
	for _, token := range strings.Split(text, "|") {
		if len(token) < 2 {
			continue
		}
		switch token[0] {
		case 'm':
			mode = token[1:]
		case 'v':
			vector = token[1:]
		case 'f':
			d.contentID = strings.ToLower(token[1:])
		}
	}
	if mode != "dcm" {
		return d, fmt.Errorf("unsupported D mode")
	}
	v, err := hex.DecodeString(vector)
	if err != nil || len(v) != 16 || len(d.contentID) != 6 {
		return d, fmt.Errorf("invalid D vector or content")
	}
	copy(d.vector[:12], v[:12])
	return d, nil
}

type sampleTextRange struct {
	start, end int
	service    bool
}

// Use the SDT service-name length, excluding its provider name and section CRC.
// A printable CRC can otherwise look like another f/m field after the final |.
func sampleDescriptorRanges(payload []byte, unitStart bool) ([]sampleTextRange, error) {
	fallback := []sampleTextRange{{0, len(payload), false}}
	if !unitStart || len(payload) < 1 {
		return fallback, nil
	}
	section := 1 + int(payload[0])
	if section+3 > len(payload) || (payload[section] != 0x42 && payload[section] != 0x46) {
		return fallback, nil
	}
	end := section + 3 + (int(payload[section+1]&15)<<8 | int(payload[section+2]))
	if end > len(payload) || end < section+15 {
		return nil, fmt.Errorf("invalid SDT section length")
	}
	end -= 4 // CRC32 is not descriptor text.
	var ranges []sampleTextRange
	for service := section + 11; service < end; {
		if service+5 > end {
			return nil, fmt.Errorf("invalid SDT service length")
		}
		loopEnd := service + 5 + (int(payload[service+3]&15)<<8 | int(payload[service+4]))
		if loopEnd > end {
			return nil, fmt.Errorf("invalid SDT descriptor loop length")
		}
		for descriptor := service + 5; descriptor < loopEnd; {
			if descriptor+2 > loopEnd {
				return nil, fmt.Errorf("invalid SDT descriptor length")
			}
			body := descriptor + 2
			descEnd := body + int(payload[descriptor+1])
			if descEnd > loopEnd {
				return nil, fmt.Errorf("invalid SDT descriptor length")
			}
			if payload[descriptor] == 0x48 {
				if body+2 > descEnd {
					return nil, fmt.Errorf("invalid SDT service descriptor")
				}
				nameLength := body + 2 + int(payload[body+1])
				if nameLength >= descEnd || nameLength+1+int(payload[nameLength]) > descEnd {
					return nil, fmt.Errorf("invalid SDT service name length")
				}
				ranges = append(ranges, sampleTextRange{nameLength + 1, nameLength + 1 + int(payload[nameLength]), true})
			}
			descriptor = descEnd
		}
		service = loopEnd
	}
	return ranges, nil
}

func sampleDescriptors(data []byte) ([]sampleDescriptor, error) {
	var records []sampleDescriptor
	for offset := 0; offset+samplePacketSize <= len(data); offset += samplePacketSize {
		packet := data[offset : offset+samplePacketSize]
		if packet[0] != 0x47 || (int(packet[1]&31)<<8|int(packet[2])) != 17 {
			continue
		}
		afc := (packet[3] >> 4) & 3
		start := 4
		if afc&2 != 0 {
			start += 1 + int(packet[4])
		}
		if afc&1 == 0 || start >= samplePacketSize {
			continue
		}
		payload := packet[start:]
		ranges, err := sampleDescriptorRanges(payload, packet[1]&0x40 != 0)
		if err != nil {
			return nil, err
		}
		for _, region := range ranges {
			for position := region.start; position < region.end; {
				index := bytes.Index(payload[position:region.end], []byte("a0|"))
				if index < 0 {
					break
				}
				index += position
				begin := index
				for region.service && begin > region.start && payload[begin-1] >= 0x20 && payload[begin-1] < 0x7f {
					begin--
				}
				// Legacy service names put the explicit mode/pattern before a0.
				end := index
				for end < region.end && payload[end] >= 0x20 && payload[end] < 0x7f {
					end++
				}
				d, err := parseSampleDescriptor(string(payload[begin:end]), offset+start+begin)
				if err != nil {
					return nil, err
				}
				records = append(records, d)
				position = end
			}
		}
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("S has no D on PID 17")
	}
	return records, nil
}

func splitSamplePES(data []byte) []samplePES {
	var list []samplePES
	var current *samplePES
	for offset := 0; offset+samplePacketSize <= len(data); offset += samplePacketSize {
		p := data[offset : offset+samplePacketSize]
		if p[0] != 0x47 || (int(p[1]&31)<<8|int(p[2])) != 0x100 {
			continue
		}
		afc := (p[3] >> 4) & 3
		start := 4
		if afc&2 != 0 {
			start += 1 + int(p[4])
		}
		if afc&1 == 0 || start >= samplePacketSize {
			continue
		}
		if current == nil || p[1]&0x40 != 0 {
			if current != nil && len(current.data) > 0 {
				list = append(list, *current)
			}
			current = &samplePES{offset: offset}
		}
		current.data = append(current.data, p[start:]...)
	}
	if current != nil && len(current.data) > 0 {
		list = append(list, *current)
	}
	return list
}

func sampleUnits(pes []byte) []sampleUnit {
	if len(pes) < 9 || pes[3] != 0xe0 {
		return nil
	}
	header := 9 + int(pes[8])
	var units []sampleUnit
	for i := header; i+3 <= len(pes); {
		if pes[i] == 0 && pes[i+1] == 0 && pes[i+2] == 1 {
			start := i
			if start > 0 && pes[start-1] == 0 {
				start--
			}
			units = append(units, sampleUnit{start: start, body: i + 5})
			i += 3
		} else {
			i++
		}
	}
	for i := range units {
		units[i].end = len(pes)
		if i+1 < len(units) {
			units[i].end = units[i+1].start
		}
	}
	valid := units[:0]
	for _, u := range units {
		if u.end > u.body {
			valid = append(valid, u)
		}
	}
	return valid
}

func restoreSampleUnit(block cipher.Block, vector [16]byte, input []byte) ([]byte, int) {
	normalized := unescapeSampleUnit(input)
	if len(normalized) != len(input) && sampleUnitG1(normalized) {
		input = normalized
	}
	length := len(input)
	if !sampleUnitG1(input) {
		return nil, -10406
	}
	counter := vector
	out := make([]byte, length)
	var stream [16]byte
	for offset := 0; offset < length; offset += 16 {
		incrementSampleCounter(&counter)
		stream = counter
		if (offset/16)%10 == 0 || length-2-offset <= 16 {
			block.Encrypt(stream[:], counter[:])
		}
		for j := 0; j < 16 && offset+j < length; j++ {
			out[offset+j] = input[offset+j] ^ stream[j]
		}
	}
	out[length-2], out[length-1] = 0, 0
	check := uint16(out[length-4]) | uint16(out[length-3])<<8
	if sampleCRC16(out[:length-4]) != check {
		return nil, -10405
	}
	return out[:length-4], 0
}

func sampleUnitG1(input []byte) bool {
	n := len(input)
	return n >= 4 && sampleCRC16(input[:n-2])&0xfeff == uint16(input[n-2])|uint16(input[n-1]>>1)<<9
}

func unescapeSampleUnit(input []byte) []byte {
	if !bytes.Contains(input, []byte{0, 0, 3}) {
		return input
	}
	output := make([]byte, 0, len(input))
	for i := 0; i < len(input); {
		if i+3 < len(input) && input[i] == 0 && input[i+1] == 0 && input[i+2] == 3 && input[i+3] <= 3 {
			output = append(output, 0, 0)
			i += 3
		} else {
			output = append(output, input[i])
			i++
		}
	}
	return output
}

func appendSamplePackets(dst []byte, pes []byte, continuity *byte) []byte {
	first := true
	for offset := 0; offset < len(pes); {
		remaining := len(pes) - offset
		var packet [188]byte
		packet[0], packet[1], packet[2] = 0x47, 1, 0
		if first {
			packet[1] |= 0x40
			first = false
		}
		packet[3] = 0x10 | (*continuity & 15)
		take := 184
		start := 4
		if remaining < 184 {
			take = remaining
			packet[3] = 0x30 | (*continuity & 15)
			padding := 183 - take
			packet[4] = byte(padding)
			start = 5 + padding
			if padding > 0 {
				packet[5] = 0
				for i := 6; i < start; i++ {
					packet[i] = 0xff
				}
			}
		}
		copy(packet[start:], pes[offset:offset+take])
		offset += take
		*continuity = (*continuity + 1) & 15
		dst = append(dst, packet[:]...)
	}
	return dst
}

// SampleRestorer holds computed K only in memory and accepts S of one content.
type SampleRestorer struct {
	block     cipher.Block
	contentID string
}

func NewSampleRestorer(ticket, identity string) (*SampleRestorer, error) {
	key, err := DeriveSampleParameter(ticket, identity)
	if err != nil {
		return nil, err
	}
	rows, err := parseSampleTicket(ticket)
	if err != nil {
		return nil, err
	}
	contentID, err := sampleContentID(rows)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return &SampleRestorer{block: block, contentID: contentID}, nil
}

// Restore preserves transport packet order and clock fields, including failed U passthrough.
// Failure counts are always reported and must be checked by callers.
func (r *SampleRestorer) Restore(ctx context.Context, data []byte) ([]byte, SampleReport, error) {
	var report SampleReport
	if len(data) == 0 || len(data)%samplePacketSize != 0 {
		return nil, report, fmt.Errorf("S size is not complete TS packets")
	}
	descriptors, err := sampleDescriptors(data)
	if err != nil {
		return nil, report, err
	}
	for _, d := range descriptors {
		if d.contentID != r.contentID {
			return nil, report, fmt.Errorf("T/S content mismatch (-10514)")
		}
	}
	report.Descriptors = len(descriptors)
	index := 0
	active := descriptors[0]
	peses := splitSamplePES(data)
	replacements := make([][]byte, len(peses))
	for pesIndex, pes := range peses {
		if err := ctx.Err(); err != nil {
			return nil, report, err
		}
		for index+1 < len(descriptors) && descriptors[index+1].offset <= pes.offset {
			index++
		}
		if active.text != descriptors[index].text {
			active = descriptors[index]
			report.Switches++
		}
		units := sampleUnits(pes.data)
		if len(units) == 0 {
			replacements[pesIndex] = pes.data
			continue
		}
		// Before the first D, this transport's prefix is clear. It must not
		// be classified as failed protected U or transformed with a future V.
		if pes.offset < descriptors[0].offset {
			report.ClearUnits += len(units)
			replacements[pesIndex] = pes.data
			continue
		}
		header := 9 + int(pes.data[8])
		if header > len(pes.data) {
			return nil, report, fmt.Errorf("invalid PES header")
		}
		newPES := append([]byte(nil), pes.data[:header]...)
		for unitIndex, unit := range units {
			if err := ctx.Err(); err != nil {
				return nil, report, err
			}
			report.Units++
			body, code := restoreSampleUnit(r.block, active.vector, pes.data[unit.body:unit.end])
			if code != 0 {
				report.Failures = append(report.Failures, SampleFailure{pesIndex, unitIndex, unit.end - unit.body, code})
				newPES = append(newPES, pes.data[unit.start:unit.end]...)
				continue
			}
			report.Passed++
			headEnd := unit.start + 5
			if headEnd > unit.body {
				headEnd = unit.body
			}
			newPES = append(newPES, pes.data[unit.start:headEnd]...)
			newPES = append(newPES, body...)
		}
		newPES[4], newPES[5] = 0, 0
		replacements[pesIndex] = newPES
	}
	output, err := repackSampleInPlace(ctx, data, peses, replacements)
	if err != nil {
		return nil, report, err
	}
	sum := sha256.Sum256(output)
	report.Bytes = len(output)
	report.SHA256 = hex.EncodeToString(sum[:])
	return output, report, nil
}

// Reuse each original video's payload slot. Shortened payload is replaced by
// adaptation stuffing; non-video packets retain their exact offset and bytes.
// Existing adaptation flags/PCR remain intact, and payload CC is recomputed.
func repackSampleInPlace(ctx context.Context, data []byte, peses []samplePES, replacements [][]byte) ([]byte, error) {
	output := append([]byte(nil), data...)
	pesIndex, position := -1, 0
	cc := byte(0)
	haveCC := false
	for offset := 0; offset+188 <= len(data); offset += 188 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		p := data[offset : offset+188]
		if p[0] != 0x47 || (int(p[1]&31)<<8|int(p[2])) != 0x100 {
			continue
		}
		afc := (p[3] >> 4) & 3
		start := 4
		if afc&2 != 0 {
			start += 1 + int(p[4])
		}
		if afc&1 == 0 || start >= 188 {
			continue
		}
		if pesIndex+1 < len(peses) && peses[pesIndex+1].offset == offset {
			if pesIndex >= 0 && position != len(replacements[pesIndex]) {
				return nil, fmt.Errorf("rebuilt PES exceeds original slots")
			}
			pesIndex++
			position = 0
		}
		if pesIndex < 0 {
			return nil, fmt.Errorf("video packet lacks PES")
		}
		body := replacements[pesIndex]
		take := len(body) - position
		if take > 188-start {
			take = 188 - start
		}
		if take < 0 {
			return nil, fmt.Errorf("invalid PES cursor")
		}
		dst := output[offset : offset+188]
		if !haveCC {
			cc = p[3] & 15
			haveCC = true
		}
		payloadCC := cc
		if take == 0 {
			payloadCC = (cc + 15) & 15
		} else {
			cc = (cc + 1) & 15
		}
		dst[3] = (p[3] & 0xc0) | payloadCC
		if take == 188-start {
			dst[3] |= afc << 4
			copy(dst[start:], body[position:position+take])
		} else {
			adaptationLength := 183 - take
			dst[3] |= 0x30
			if take == 0 {
				dst[3] = (dst[3] & 0xcf) | 0x20
				dst[1] &= ^byte(0x40)
			}
			dst[4] = byte(adaptationLength)
			for i := 5; i < 188-take; i++ {
				dst[i] = 0xff
			}
			if adaptationLength > 0 {
				dst[5] = 0
			}
			if afc&2 != 0 && p[4] > 0 {
				copy(dst[5:5+int(p[4])], p[5:5+int(p[4])])
			}
			copy(dst[188-take:], body[position:position+take])
		}
		position += take
	}
	if pesIndex >= 0 && position != len(replacements[pesIndex]) {
		return nil, fmt.Errorf("final PES exceeds original slots")
	}
	return output, nil
}
